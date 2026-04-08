import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Pool } from 'pg';
const copyFrom = require('pg-copy-streams').from;
import { initDB, disableLeakDetection, enableLeakDetection } from '../database';
import { mbdbStatus, broadcastMbdbStatus, setMbdbCancelRequested, getMbdbCancelRequested } from '../state';

const MBDB_WORK_DIR = process.env.MBDB_WORK_DIR || path.join(process.cwd(), 'mbdb-data');

function cleanupStaleWorkDir() {
  if (fs.existsSync(MBDB_WORK_DIR)) {
    console.log('[MBDB] Cleaning up stale work directory from previous/crashed import...');
    fs.rmSync(MBDB_WORK_DIR, { recursive: true, force: true });
  }
}

export class MBDBService {
  private updateStatus(updates: Partial<typeof mbdbStatus>) {
    Object.assign(mbdbStatus, updates);
    broadcastMbdbStatus();
  }

  public async importDatabase(): Promise<void> {
    if (mbdbStatus.isImporting) throw new Error('MBDB import already in progress');
    
    cleanupStaleWorkDir();
    setMbdbCancelRequested(false);

    const startTime = Date.now();
    const workDir = MBDB_WORK_DIR;
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

    this.updateStatus({
      isImporting: true,
      phase: 'downloading',
      progress: 0,
      message: 'Downloading & extracting dump...',
      elapsedSeconds: 0,
      currentTable: '',
      counts: { genres: 0, aliases: 0, links: 0 },
      completedPhases: [],
    });

    await this.checkDiskSpace(MBDB_WORK_DIR, 7 * 1024 * 1024 * 1024);

    disableLeakDetection();

    try {
      const dataTag = await this.downloadAndExtractStream(workDir, startTime);
      
      this.updateStatus({ 
        phase: 'inserting', 
        progress: 0, 
        message: 'Inserting data into database...',
        elapsedSeconds: 0,
      });
      const counts = await this.insertTableData(workDir, startTime);

      this.updateStatus({ 
        phase: 'refreshing', 
        progress: 0, 
        message: 'Building genre hierarchy tree...',
        elapsedSeconds: 0,
      });
      await this.refreshMaterializedView();

      const totalSeconds = Math.round((Date.now() - startTime) / 1000);
      const duration = (totalSeconds / 60).toFixed(1);
      const resultMessage = `MusicBrainz Database import completed in ${duration}min. Records: ${counts.genres} genres, ${counts.aliases} aliases, ${counts.links} links.`;
      
      this.updateStatus({
        phase: 'complete',
        progress: 100,
        message: resultMessage,
        isImporting: false,
        elapsedSeconds: totalSeconds,
        counts,
        lastImport: {
          timestamp: Date.now(),
          duration: totalSeconds,
          counts
        }
      });

      const { setSystemSetting } = await import('../database');
      await setSystemSetting('mbdbLastImport', JSON.stringify({
        timestamp: Date.now(),
        status: 'success',
        tag: dataTag,
        duration: totalSeconds,
        counts
      }));

    } catch (err: any) {
      console.error('[MBDB] Import failed:', err);
      this.updateStatus({
        phase: 'error',
        message: 'Import failed: ' + err.message,
        isImporting: false,
      });
    } finally {
      enableLeakDetection();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  public cancelImport() {
    setMbdbCancelRequested(true);
    this.updateStatus({
      phase: 'error',
      message: 'Import cancelled by user',
      isImporting: false,
    });
  }

  private getElapsed(startTime: number): number {
    return Math.round((Date.now() - startTime) / 1000);
  }

  private async checkDiskSpace(dir: string, requiredBytes: number): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.statfs(dir, (err, stats) => {
        if (err) {
          console.warn(`[MBDB] Could not check disk space for ${dir}: ${err.message}. Proceeding anyway.`);
          return resolve();
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

  private async downloadAndExtractStream(workDir: string, startTime: number): Promise<string> {
    const phaseStartTime = Date.now();
    const latestResponse = await fetch('https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST');
    const latestTag = (await latestResponse.text()).trim();
    if (!latestTag || latestTag.length > 50) throw new Error('Could not fetch MusicBrainz LATEST valid tag');

    this.updateStatus({ 
      message: `Downloading MusicBrainz dump (${latestTag})...`
    });

    return new Promise((resolve, reject) => {
      const url = `https://data.metabrainz.org/pub/musicbrainz/data/fullexport/${latestTag}/mbdump.tar.bz2`;
      // Use --show-error but not --progress-bar to keep stderr clean for our own status updates
      const curlCmd = `curl -sL --show-error --retry 5 --retry-delay 10 --retry-all-errors "${url}"`;
      // mbdump.tar.bz2 is ~4GB. tar must scan the whole thing. We extract only what we need.
      const tarCmd = `tar -xjf - -C "${workDir}" mbdump/genre mbdump/genre_alias mbdump/l_genre_genre`;
      const cmd = `${curlCmd} | ${tarCmd}`;
      
      console.log(`[MBDB] Starting download stream: ${cmd}`);
      const child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'ignore', 'pipe'] });

      const mbdumpDir = path.join(workDir, 'mbdump');

      const watchdog = setInterval(() => {
        if (getMbdbCancelRequested()) {
          clearInterval(watchdog);
          child.kill();
          reject(new Error('Import cancelled'));
          return;
        }

        if (!fs.existsSync(mbdumpDir)) return;
        try {
          const files = ['genre', 'genre_alias', 'l_genre_genre'];
          let totalExtracted = 0;
          let filesFound = 0;
          for (const f of files) {
            const p = path.join(mbdumpDir, f);
            if (fs.existsSync(p)) {
              totalExtracted += fs.statSync(p).size;
              filesFound++;
            }
          }
          
          const extractedMB = (totalExtracted / 1024 / 1024).toFixed(1);
          const elapsed = this.getElapsed(phaseStartTime);
          
          // Reassure the user because it takes a long time for tar to reach the files in 4GB bz2
          const message = totalExtracted === 0 
            ? `Downloading & scanning archive... (${elapsed}s, no files reached yet)`
            : `Extracting taxonomy... ${extractedMB} MB written (${filesFound}/${files.length} tables found)`;

          this.updateStatus({ 
            message,
            elapsedSeconds: elapsed
          });
        } catch (e) {}
      }, 2000);

      let errorOutput = '';

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        clearInterval(watchdog);
        if (getMbdbCancelRequested()) return;
        
        if (code !== 0 && code !== null) {
          return reject(new Error(`Command failed with code ${code}: ${errorOutput}`));
        }

        const mbdumpDir = path.join(workDir, 'mbdump');
        if (!fs.existsSync(mbdumpDir) || !fs.existsSync(path.join(mbdumpDir, 'genre')) || !fs.existsSync(path.join(mbdumpDir, 'genre_alias')) || !fs.existsSync(path.join(mbdumpDir, 'l_genre_genre'))) {
          return reject(new Error('Extraction finished but one or more expected TSV files (genre, genre_alias, l_genre_genre) are missing.'));
        }

        const elapsed = this.getElapsed(phaseStartTime);
        this.updateStatus({ 
          message: `Downloading & extracting... took ${elapsed} seconds`,
          completedPhases: [...mbdbStatus.completedPhases, `Downloading... took ${elapsed} seconds`]
        });

        resolve(latestTag);
      });
    });
  }

  private async copyFromFile(pool: Pool, filePath: string, tableName: string, phaseStartTime: number): Promise<number> {
    if (!fs.existsSync(filePath)) {
      console.warn(`[MBDB] TSV file not found: ${filePath}, skipping ${tableName}`);
      return 0;
    }

    const stats = fs.statSync(filePath);
    let bytesRead = 0;

    const client = await pool.connect();

    try {
      await client.query("SET statement_timeout = '1 h'");

      const copyQuery = `COPY ${tableName} FROM STDIN WITH (FORMAT text, DELIMITER '\t', NULL '\\N')`;
      const copyStream = client.query(copyFrom(copyQuery));

      const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });

      readStream.on('data', (chunk: Buffer) => {
        if (getMbdbCancelRequested()) {
          readStream.destroy();
          copyStream.destroy();
          return;
        }
        bytesRead += chunk.length;
        const prog = Math.round((bytesRead / stats.size) * 100);
        this.updateStatus({ 
          progress: prog, 
          message: `Inserting ${tableName}...`,
          currentTable: tableName,
          elapsedSeconds: this.getElapsed(phaseStartTime)
        });
      });

      await pipeline(readStream, copyStream);

      const result = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
      const count = parseInt(result.rows[0].count, 10);
      console.log(`[MBDB] Inserted ${count} rows into ${tableName}`);
      return count;
    } finally {
      await client.query('RESET statement_timeout');
      client.release();
    }
  }

  private async insertTableData(workDir: string, startTime: number): Promise<{ genres: number; aliases: number; links: number }> {
    const mbdumpDir = path.join(workDir, 'mbdump');
    const pool = await initDB();

    this.updateStatus({ message: 'Truncating tables...', currentTable: '' });
    await pool.query('TRUNCATE genre, genre_alias, l_genre_genre RESTART IDENTITY CASCADE');

    const genreStart = Date.now();
    this.updateStatus({ message: 'Inserting genres...', currentTable: 'genre' });
    const genres = await this.copyFromFile(pool, path.join(mbdumpDir, 'genre'), 'genre', genreStart);
    const genreTime = this.getElapsed(genreStart);

    const aliasStart = Date.now();
    this.updateStatus({ message: 'Inserting aliases...', currentTable: 'genre_alias', counts: { ...mbdbStatus.counts, genres } });
    const aliases = await this.copyFromFile(pool, path.join(mbdumpDir, 'genre_alias'), 'genre_alias', aliasStart);
    const aliasTime = this.getElapsed(aliasStart);

    const linkStart = Date.now();
    this.updateStatus({ message: 'Inserting links...', currentTable: 'l_genre_genre', counts: { ...mbdbStatus.counts, aliases } });
    const links = await this.copyFromFile(pool, path.join(mbdumpDir, 'l_genre_genre'), 'l_genre_genre', linkStart);
    const linkTime = this.getElapsed(linkStart);

    // Update planner statistics before the materialized view refresh.
    // Critical: without ANALYZE, the planner has zero stats after TRUNCATE+COPY
    // and will produce catastrophically slow query plans for the recursive CTE.
    this.updateStatus({ message: 'Analyzing tables (updating planner stats)...', currentTable: '' });
    await pool.query('ANALYZE genre, genre_alias, l_genre_genre');
    console.log('[MBDB] ANALYZE complete');

    const counts = { genres, aliases, links };
    const totalInsertTime = genreTime + aliasTime + linkTime;

    this.updateStatus({ 
      counts, 
      currentTable: '',
      completedPhases: [
        ...mbdbStatus.completedPhases,
        `Inserting genres... took ${genreTime}s (${genres.toLocaleString()} rows)`,
        `Inserting aliases... took ${aliasTime}s (${aliases.toLocaleString()} rows)`,
        `Inserting links... took ${linkTime}s (${links.toLocaleString()} rows)`,
      ]
    });

    return counts;
  }

  private async refreshMaterializedView() {
    const phaseStartTime = Date.now();
    const pool = await initDB();
    const client = await pool.connect();
    
    try {
      await client.query("SET statement_timeout = '1 h'");
      // Use a conservative work_mem during the recursive CTE evaluation.
      // The default (4MB) can force repeated disk spills on large genre graphs.
      await client.query("SET LOCAL work_mem = '256MB'");
      
      let done = false;
      const refreshPromise = client.query('REFRESH MATERIALIZED VIEW genre_tree_paths');
      
      refreshPromise.then(() => { done = true; }).catch(() => { done = true; });

      while (!done) {
        if (getMbdbCancelRequested()) {
          throw new Error('Import cancelled');
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        this.updateStatus({ 
          message: `Building hierarchy tree... ${this.getElapsed(phaseStartTime)}s`,
          elapsedSeconds: this.getElapsed(phaseStartTime)
        });
      }
      
      await refreshPromise;
      
      const elapsed = this.getElapsed(phaseStartTime);
      this.updateStatus({ 
        message: `Building hierarchy tree... took ${elapsed} seconds`,
        elapsedSeconds: elapsed,
        completedPhases: [...mbdbStatus.completedPhases, `Building hierarchy... took ${elapsed}s`]
      });
      
      console.log('[MBDB] Materialized view refreshed');
    } finally {
      await client.query('RESET statement_timeout');
      client.release();
    }
  }
}

export const mbdbService = new MBDBService();
