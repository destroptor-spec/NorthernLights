import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ChildProcessPool } from '../workers/processPool';
import * as mm from 'music-metadata';
import { addDirectory, addTrack, addTrackFeatures, getTracksWithoutFeatures, getTrackCountWithFeatures, getAllTracks, getDirectories, removeDirectory, removeTracksByDirectory, getOrCreateArtist, getOrCreateAlbum, getOrCreateGenre, getAllArtists, getAllAlbums, getAllGenres } from '../database';
import { genreMatrixService } from '../services/genreMatrix.service';
import { scanStatus, scanClients, broadcastScanStatus } from '../state';

const router = Router();

// Mime type map
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

// ─── Scan status SSE ─────────────────────────────────────────────────
router.get('/scan/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  scanClients.add(res);
  res.write(`data: ${JSON.stringify(scanStatus)}\n\n`);

  req.on('close', () => {
    scanClients.delete(res);
  });
});

// ─── Phase 1: Recursive directory walk ────────────────────────────────
async function collectAudioFiles(dirBuf: Buffer, results: Buffer[] = []): Promise<Buffer[]> {
  const sep = Buffer.from(path.sep);
  let entries: Buffer[];
  try {
    entries = await fs.promises.readdir(dirBuf, { encoding: 'buffer' });
  } catch {
    return results;
  }

  await Promise.all(entries.map(async (nameBuffer) => {
    const fullBuf = Buffer.concat([
      dirBuf,
      dirBuf[dirBuf.length - 1] === sep[0] ? Buffer.alloc(0) : sep,
      nameBuffer,
    ]);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullBuf);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      await collectAudioFiles(fullBuf, results);
    } else if (stat.isFile() && nameBuffer.toString('utf8').match(/\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i)) {
      results.push(fullBuf);
    }
  }));

  return results;
}

// ─── Phase 2: Parallel metadata extraction (ID3 tags only, no audio analysis) ─
async function getScannerConcurrency(): Promise<number> {
  try {
    const { getSystemSetting } = await import('../database');
    const setting = await getSystemSetting('scannerConcurrency');
    switch (setting) {
      case 'HDD': return 4;
      case 'NVMe': return 32;
      case 'SSD':
      default: return 16;
    }
  } catch {
    return 16;
  }
}

async function processMetadataBatch(fileBufs: Buffer[], concurrency: number): Promise<void> {
  const { settingsEmitter } = await import('../state');
  let index = 0;
  const activeSet = new Set<string>();
  const total = fileBufs.length;

  let currentConcurrency = Math.min(concurrency, total);
  const pool = new ChildProcessPool(path.resolve(__dirname, '../workers/scanTrack.ts'), currentConcurrency);
  await pool.init();

  let activeLoops = 0;
  let orchestrationActive = true;
  const activePromises = new Set<Promise<void>>();

  const runWorkerLoop = async () => {
    activeLoops++;
    try {
      while (orchestrationActive && activeLoops <= currentConcurrency && index < total) {
        const i = index++;
        if (i >= total) break;

        const fullBuf = fileBufs[i];
        const dbPath = fullBuf.toString('base64');
        const utf8StringPath = fullBuf.toString('utf8');
        const nameStr = path.basename(utf8StringPath);
        let activeLabel = nameStr; 

        activeSet.add(activeLabel);
        scanStatus.activeFiles = Array.from(activeSet);
        scanStatus.currentFile = activeLabel;
        scanStatus.scannedFiles++;
        try {
          const jobPromise = pool.runJob({
            id: dbPath,
            payload: {
              id: dbPath,
              filePathBase64: dbPath,
              nameStr: nameStr
            }
          });

          scanStatus.activeWorkers = pool.getActiveCount();
          broadcastScanStatus();

          const result = await jobPromise;

          if (result.metadata) {
            const metadata = result.metadata;
            const displayArtist = metadata.artist || metadata.albumartist;
            const displayTitle = metadata.title || nameStr;
            activeLabel = displayArtist ? `${displayArtist} - ${displayTitle}` : nameStr;
            
            activeSet.delete(nameStr);
            activeSet.add(activeLabel);
            scanStatus.activeFiles = Array.from(activeSet);
            scanStatus.currentFile = activeLabel;
            broadcastScanStatus();

            let artists = metadata.artists;
            if (!artists && metadata.artist) {
              const splitRegex = /\s+(?:feat\.?|ft\.?|featuring|&)\s+(?!$)/i;
              const parts = metadata.artist.split(splitRegex).map((s: string) => s.trim()).filter(Boolean);
              if (parts.length > 0) artists = parts;
            }

            const albumArtistName = metadata.albumartist || metadata.artist || null;
            const albumTitle = metadata.album || null;
            // Split dirty genre tags like "folk, country, blues" into individual genres
            let genreName: string | null = null;
            if (metadata.genre && metadata.genre.length > 0) {
                const raw = metadata.genre[0];
                const parts = raw.split(/[,;/&]/).map((s: string) => s.trim()).filter(Boolean);
                genreName = parts.length > 0 ? parts[0] : null;
            }

            let artistId = null;
            let albumId = null;
            let genreId = null;
            try { if (albumArtistName) artistId = await getOrCreateArtist(albumArtistName); } catch (e) { /* skip */ }
            if (artists) {
              for (const a of artists) {
                try { await getOrCreateArtist(a); } catch (e) { /* skip */ }
              }
            }
            try { if (albumTitle) albumId = await getOrCreateAlbum(albumTitle, albumArtistName); } catch (e) { /* skip */ }
            try { if (genreName) genreId = await getOrCreateGenre(genreName); } catch (e) { /* skip */ }

            await addTrack({
              path: dbPath,
              title: metadata.title || nameStr,
              artist: metadata.artist || metadata.albumartist || null,
              albumArtist: metadata.albumartist || null,
              artists: artists || null,
              album: albumTitle,
              genre: genreName,
              duration: metadata.duration || 0,
              trackNumber: metadata.trackNumber || null,
              year: metadata.year || null,
              releaseType: metadata.releaseType || null,
              isCompilation: metadata.isCompilation || false,
              bitrate: metadata.bitrate || null,
              format: metadata.format || null,
              artistId,
              albumId,
              genreId
            });

            if (!metadata.genre || metadata.genre.length === 0) {
              console.warn(`[Scanner] No genre found for "${nameStr}". Hop-cost logic will be restricted.`);
            }
          } else {
            console.warn(`Failed to parse metadata for ${nameStr}: ${result.error}`);
            await addTrack({ path: dbPath, title: nameStr, bitrate: null, format: null });
          }
        } catch (err) {
          console.warn(`Failed metadata processing for ${nameStr}`, err);
          await addTrack({ path: dbPath, title: nameStr, bitrate: null, format: null });
        } finally {
          activeSet.delete(activeLabel);
          scanStatus.activeFiles = Array.from(activeSet);
          scanStatus.activeWorkers = pool.getActiveCount();
          broadcastScanStatus();
        }
      }
    } finally {
      activeLoops--;
    }
  };

  const updateConcurrency = (newLimit: number) => {
    currentConcurrency = newLimit;
    pool.resize(newLimit);
    while (activeLoops < currentConcurrency && index < total) {
      const p = runWorkerLoop();
      activePromises.add(p);
      p.finally(() => activePromises.delete(p));
    }
  };

  const onSettingsChanged = async () => {
    if (!orchestrationActive) return;
    try {
      const newLimitConf = await getScannerConcurrency();
      const newLimit = Math.min(newLimitConf, total);
      if (newLimit !== currentConcurrency) {
        console.log(`[Scanner] Dynamically scaling metadata concurrency ${currentConcurrency} -> ${newLimit}`);
        updateConcurrency(newLimit);
      }
    } catch { /* ignore */ }
  };

  settingsEmitter.on('concurrencyChanged', onSettingsChanged);
  updateConcurrency(currentConcurrency);

  while (index < total || activePromises.size > 0) {
    await new Promise(r => setTimeout(r, 100));
  }

  orchestrationActive = false;
  settingsEmitter.off('concurrencyChanged', onSettingsChanged);
  pool.terminate();
}

// ─── Phase 3: Parallel audio analysis (ffmpeg + Essentia) ────────────

async function getAnalysisConcurrency(): Promise<number> {
  try {
    const { getSystemSetting } = await import('../database');
    const setting = await getSystemSetting('audioAnalysisCpu');
    switch (setting) {
      case 'Background':   return 1;
      case 'Balanced':     return 4;
      case 'Performance':  return 8;
      case 'Intensive':    return 16;
      case 'Maximum': {
        // Use all logical CPU cores reported by the OS
        const { cpus } = await import('os');
        return Math.max(1, cpus().length);
      }
      default: return 4; // Balanced
    }
  } catch {
    return 4;
  }
}

async function processAnalysisBatch(tracks: { id: string; filePath: Buffer; title: string; artist?: string | null }[], concurrency: number): Promise<void> {
  const { settingsEmitter } = await import('../state');
  let index = 0;
  const total = tracks.length;
  const activeSet = new Set<string>();

  let currentConcurrency = Math.min(concurrency, total);
  const pool = new ChildProcessPool(path.resolve(__dirname, '../workers/analyzeTrack.ts'), currentConcurrency);
  await pool.init();

  let activeLoops = 0;
  let orchestrationActive = true;
  const activePromises = new Set<Promise<void>>();

  const runWorkerLoop = async () => {
    activeLoops++;
    try {
      while (orchestrationActive && activeLoops <= currentConcurrency && index < total) {
        const i = index++;
        if (i >= total) break;

        const track = tracks[i];
        const displayName = track.artist ? `${track.artist} - ${track.title}` : track.title;
        
        activeSet.add(displayName);
        scanStatus.activeFiles = Array.from(activeSet);
        scanStatus.currentFile = displayName;
        scanStatus.scannedFiles++;
        try {
          const jobPromise = pool.runJob({
            id: track.id,
            payload: {
              id: track.id,
              filePathBase64: track.filePath.toString('base64')
            }
          });

          scanStatus.activeWorkers = pool.getWorkerCount();
          broadcastScanStatus();

          const result = await jobPromise;

          if (result.audioFeatures) {
            try {
              await addTrackFeatures(result.id, result.audioFeatures);
            } catch (err) {
              console.warn(`[Analysis] DB write failed for track ${result.id}:`, err);
            }
          } else if (result.error) {
            console.warn(`[Analysis] Failed for "${track.title || result.id}": ${result.error}`);
          }
        } catch (err) {
          console.error(`[Analysis] Job failed for "${track.title}":`, err);
        } finally {
          activeSet.delete(displayName);
          scanStatus.activeFiles = Array.from(activeSet);
          scanStatus.activeWorkers = pool.getWorkerCount();
          broadcastScanStatus();
        }
      }
    } finally {
      activeLoops--;
    }
  };

  const updateConcurrency = (newLimit: number) => {
    currentConcurrency = newLimit;
    pool.resize(newLimit);
    while (activeLoops < currentConcurrency && index < total) {
      const p = runWorkerLoop();
      activePromises.add(p);
      p.finally(() => activePromises.delete(p));
    }
  };

  const onSettingsChanged = async () => {
    if (!orchestrationActive) return;
    try {
      const newLimitConf = await getAnalysisConcurrency();
      const newLimit = Math.min(newLimitConf, total);
      if (newLimit !== currentConcurrency) {
        console.log(`[Analysis] Dynamically scaling worker concurrency ${currentConcurrency} -> ${newLimit}`);
        updateConcurrency(newLimit);
      }
    } catch { /* ignore */ }
  };

  settingsEmitter.on('concurrencyChanged', onSettingsChanged);
  updateConcurrency(currentConcurrency);

  while (index < total || activePromises.size > 0) {
    await new Promise(r => setTimeout(r, 100));
  }

  orchestrationActive = false;
  settingsEmitter.off('concurrencyChanged', onSettingsChanged);
  pool.terminate();
}

// ─── Shared scan lifecycle helpers ────────────────────────────────────

function resetScanStatus() {
  scanStatus.isScanning = false;
  scanStatus.phase = 'idle';
  scanStatus.currentFile = '';
  scanStatus.activeFiles = [];
  scanStatus.activeWorkers = 0;
  broadcastScanStatus(true);
}

// ─── API Endpoints ────────────────────────────────────────────────────

// Add a mapped folder
router.post('/add', async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter' });
  }
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: 'Path does not exist or is not a directory' });
  }
  try {
    await addDirectory(dirPath);
    res.json({ status: 'added' });
  } catch (error) {
    console.error('Add mapping error:', error);
    res.status(500).json({ error: 'Failed to add directory mapping' });
  }
});

// Trigger library scan (walk → metadata → analysis, all in one)
router.post('/scan', async (req, res) => {
  console.log('Scan Request Received. Body:', JSON.stringify(req.body));
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter in body' });
  }

  if (!fs.existsSync(dirPath)) {
    return res.status(400).json({ error: 'Path does not exist' });
  }

  if (!fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: 'Path is not a directory' });
  }

  if (scanStatus.isScanning) {
    return res.status(400).json({ error: 'Scan already in progress' });
  }

  try {
    scanStatus.isScanning = true;
    scanStatus.scannedFiles = 0;
    scanStatus.totalFiles = 0;
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    scanStatus.phase = 'walk';
    scanStatus.currentFile = `Walking ${path.basename(dirPath)}...`;
    broadcastScanStatus(true);

    await addDirectory(dirPath);

    // ── Walk ──
    const dirBuf = Buffer.from(dirPath, 'utf8');
    const fileBufs = await collectAudioFiles(dirBuf);

    if (fileBufs.length === 0) {
      console.warn(`[Scanner] No audio files found in ${dirPath}.`);
    }

    // ── Metadata ──
    scanStatus.phase = 'metadata';
    scanStatus.totalFiles = fileBufs.length;
    scanStatus.scannedFiles = 0;
    scanStatus.currentFile = '';
    broadcastScanStatus(true);
    const metadataConcurrency = await getScannerConcurrency();
    await processMetadataBatch(fileBufs, metadataConcurrency);
    console.log(`[Scanner] Metadata phase complete: ${fileBufs.length} files`);

    // ── Analysis ──
    const tracksNeedingAnalysis = await getTracksWithoutFeatures();
    if (tracksNeedingAnalysis.length > 0) {
      scanStatus.phase = 'analysis';
      scanStatus.totalFiles = tracksNeedingAnalysis.length;
      scanStatus.scannedFiles = 0;
      scanStatus.currentFile = '';
      broadcastScanStatus(true);
      const concurrency = await getAnalysisConcurrency();
      await processAnalysisBatch(tracksNeedingAnalysis, concurrency);
      console.log(`[Scanner] Analysis phase complete: ${tracksNeedingAnalysis.length} tracks analyzed`);
    }

    console.log(`[Scanner] Full scan completed for ${dirPath}: ${fileBufs.length} files`);

    // Trigger Genre Matrix regeneration after scan
    setImmediate(() => {
      genreMatrixService.runDiffAndGenerate()
        .catch(e => console.error('[Genre Matrix] Post-scan categorization failed:', e));
    });

    res.json({ status: 'completed', message: `Scan completed for ${dirPath}` });
  } catch (error) {
    console.error('Scan init error:', error);
    res.status(500).json({ error: 'Failed to complete scan' });
  } finally {
    resetScanStatus();
  }
});

// Trigger standalone analysis (no scan — analyzes tracks missing features)
router.post('/analyze', async (req, res) => {
  if (scanStatus.isScanning) {
    return res.status(400).json({ error: 'A scan or analysis is already in progress' });
  }

  const force = req.body?.force === true;

  try {
    let tracksToAnalyze: { id: string; filePath: Buffer; title: string }[];

    if (force) {
      // Re-analyze ALL tracks (e.g., after Essentia upgrade)
      const { initDB } = await import('../database');
      const db = await initDB();
      const dbRes = await db.query('SELECT t.id, t.path, t.title, t.artist FROM tracks t ORDER BY t.title');
      tracksToAnalyze = dbRes.rows.map((r: any) => ({
        id: r.id,
        filePath: Buffer.from(r.path, 'base64'),
        title: r.title,
        artist: r.artist || null,
      }));
    } else {
      tracksToAnalyze = await getTracksWithoutFeatures();
    }

    if (tracksToAnalyze.length === 0) {
      return res.json({ status: 'completed', message: 'All tracks already have audio features', count: 0 });
    }

    scanStatus.isScanning = true;
    scanStatus.phase = 'analysis';
    scanStatus.totalFiles = tracksToAnalyze.length;
    scanStatus.scannedFiles = 0;
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    scanStatus.currentFile = '';
    broadcastScanStatus(true);

    const concurrency = await getAnalysisConcurrency();
    await processAnalysisBatch(tracksToAnalyze, concurrency);
    console.log(`[Analysis] Standalone analysis complete: ${tracksToAnalyze.length} tracks`);

    // Trigger Genre Matrix regeneration after analysis
    setImmediate(() => {
      genreMatrixService.runDiffAndGenerate()
        .catch(e => console.error('[Genre Matrix] Post-analysis categorization failed:', e));
    });

    res.json({ status: 'completed', message: `Analyzed ${tracksToAnalyze.length} tracks`, count: tracksToAnalyze.length });
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Failed to complete analysis' });
  } finally {
    resetScanStatus();
  }
});

// Get analysis status (how many tracks have features vs total)
router.get('/analyze/status', async (req, res) => {
  try {
    const counts = await getTrackCountWithFeatures();
    res.json(counts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get analysis status' });
  }
});

// Remove a mapped folder
router.post('/remove', async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter' });
  }

  try {
    await removeDirectory(dirPath);
    await removeTracksByDirectory(dirPath);
    console.log(`Removed directory and tracks for ${dirPath}`);
    res.json({ status: 'removed' });
  } catch (error) {
    console.error('Remove error:', error);
    res.status(500).json({ error: 'Failed to remove directory' });
  }
});

// Get entire library
router.get('/', async (req, res) => {
  try {
    const tracks = await getAllTracks();
    const directories = await getDirectories();
    const artists = await getAllArtists();
    const albums = await getAllAlbums();
    const genres = await getAllGenres();
    res.json({ tracks, directories, artists, albums, genres });
  } catch (error) {
    console.error('DB fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch library' });
  }
});

// Get per-directory stats (total tracks, with metadata, analyzed)
router.get('/stats', async (req, res) => {
  try {
    const { getDirectories } = await import('../database');
    const db = await (await import('../database')).initDB();

    const dirs = await getDirectories();
    if (dirs.length === 0) {
      return res.json({ directories: [] });
    }

    // Base64-encode the directory path and escape SQL LIKE special chars (% and _)
    const toLikePrefix = (dirPath: string) =>
      Buffer.from(dirPath, 'utf8').toString('base64')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');

    const result = [];

    for (const dir of dirs) {
      const dirBuf = Buffer.from(dir, 'utf8');
      const likePrefix = toLikePrefix(dir);

      // SQL pre-filter: only rows whose base64 path starts with this directory's base64
      const tracksRes = await db.query(`
        SELECT t.path,
               t.artist IS NOT NULL AND t.artist != '' AS has_artist,
               t.album IS NOT NULL AND t.album != '' AS has_album,
               tf.track_id IS NOT NULL AS has_features
        FROM tracks t
        LEFT JOIN track_features tf ON t.id = tf.track_id
        WHERE t.path LIKE $1 || '%'
      `, [likePrefix]);

      let total = 0;
      let withMetadata = 0;
      let analyzed = 0;

      for (const row of tracksRes.rows) {
        const fileBuf = Buffer.from(row.path, 'base64');
        // Precise byte-level check: prefix must match and fall on a path separator boundary
        const prefixMatches = fileBuf.length >= dirBuf.length && fileBuf.slice(0, dirBuf.length).equals(dirBuf);
        const atBoundary = fileBuf.length === dirBuf.length || fileBuf[dirBuf.length] === 0x2F; // '/'
        if (prefixMatches && atBoundary) {
          total++;
          if (row.has_artist || row.has_album) withMetadata++;
          if (row.has_features) analyzed++;
        }
      }

      result.push({ path: dir, totalTracks: total, withMetadata, analyzed });
    }

    res.json({ directories: result });
  } catch (error) {
    console.error('Library stats error:', error);
    res.status(500).json({ error: 'Failed to get library stats' });
  }
});

export default router;
