import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ChildProcessPool } from '../workers/processPool';
import * as mm from 'music-metadata';
import { addDirectory, addTrack, addTrackFeatures, getTracksWithoutFeatures, getTrackCountWithFeatures, getAllTracks, getDirectories, removeDirectory, removeTracksByDirectory, getOrCreateArtist, getOrCreateAlbum, getOrCreateGenre, getAllArtists, getAllAlbums, getAllGenres, getExistingPaths, deleteTracksByIds } from '../database';
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
      case 'NVMe': return 12;
      case 'SSD':
      default: return 10;
    }
  } catch {
    return 10;
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

            // Split artists
            const rawArtistsField = metadata.artists;
            const rawArtist = metadata.artist;
            let finalArtists: string[] = [];
            
            if (rawArtistsField) {
              if (Array.isArray(rawArtistsField)) {
                finalArtists = rawArtistsField;
              } else {
                finalArtists = [rawArtistsField];
              }
            } else if (rawArtist) {
              const { splitArtistNames } = await import('../database');
              finalArtists = splitArtistNames(rawArtist);
            }
            if (finalArtists.length === 0 && rawArtist) {
              finalArtists = [rawArtist];
            }

            const albumArtistName = metadata.albumartist || metadata.artist || null;
            const albumTitle = metadata.album || null;

            // Split genres
            let finalGenres: string[] = [];
            const rawGenreLine = metadata.genre && metadata.genre.length > 0 ? metadata.genre[0] : null;
            if (rawGenreLine) {
              const { splitGenreNames } = await import('../database');
              finalGenres = splitGenreNames(rawGenreLine);
            }
            const primaryGenreName = finalGenres.length > 0 ? finalGenres[0] : null;

            let artistId = null;
            let albumId = null;
            let genreId = null;
            try { artistId = await getOrCreateArtist(albumArtistName); } catch (e) { /* skip */ }
            for (const a of finalArtists) {
              try { await getOrCreateArtist(a); } catch (e) { /* skip */ }
            }
            try { albumId = await getOrCreateAlbum(albumTitle, albumArtistName); } catch (e) { /* skip */ }
            try { genreId = await getOrCreateGenre(primaryGenreName); } catch (e) { /* skip */ }

            await addTrack({
              path: dbPath,
              title: metadata.title || nameStr,
              artist: metadata.artist || metadata.albumartist || null,
              albumArtist: metadata.albumartist || null,
              artists: finalArtists.length > 0 ? finalArtists : null,
              album: albumTitle,
              genre: primaryGenreName,
              duration: metadata.duration || 0,
              trackNumber: metadata.trackNumber || null,
              year: metadata.year || null,
              releaseType: metadata.releaseType || null,
              isCompilation: metadata.isCompilation || false,
              bitrate: metadata.bitrate || null,
              format: metadata.format || null,
              artistId,
              albumId,
              genreId,
              genres: finalGenres.length > 0 ? finalGenres : null,
              isrc: metadata.isrc || null,
              mbRecordingId: metadata.mbRecordingId || null,
              mbTrackId: metadata.mbTrackId || null,
              mbAlbumId: metadata.mbAlbumId || null,
              mbArtistId: metadata.mbArtistId || null,
              mbAlbumArtistId: metadata.mbAlbumArtistId || null,
              mbReleaseGroupId: metadata.mbReleaseGroupId || null,
              mbWorkId: metadata.mbWorkId || null
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
  const { getVectorStats } = await import('../database');
  let index = 0;
  const total = tracks.length;
  const activeSet = new Set<string>();

  // Fetch vector stats once for the entire batch instead of per-track
  let vectorStats: any = null;
  try {
    vectorStats = await getVectorStats();
    console.log(`[Analysis] Loaded vector stats for ${total} tracks (cached for batch)`);
  } catch (err) {
    console.warn('[Analysis] Failed to fetch vector stats, will use per-track fallback');
  }

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
              filePathBase64: track.filePath.toString('base64'),
              vectorStats
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

    await runSyncWalk(dirPath);

    res.json({ status: 'completed', message: `Scan completed for ${dirPath}` });
  } catch (error) {
    console.error('Scan init error:', error);
    res.status(500).json({ error: 'Failed to complete scan' });
  } finally {
    resetScanStatus();
  }
});

// ─── Sync Walk: diff disk vs DB, remove stale, scan new ───────────────
// Exported so the auto-walk scheduler in server/index.ts can reuse it.
export async function runSyncWalk(dirPath: string): Promise<{ removed: number; added: number }> {
  const dirBuf = Buffer.from(dirPath, 'utf8');

  // ── Walk ──
  const fileBufs = await collectAudioFiles(dirBuf);
  const diskPaths = new Set(fileBufs.map(b => b.toString('base64')));

  // ── Diff against DB ──
  // Get all paths currently known for this directory
  const allExisting = await getExistingPaths(); // Set<base64-path>

  const staleIds: string[] = [];
  for (const existingPath of allExisting) {
    // Only consider tracks that belong to this directory (byte-level prefix check)
    const fileBuf = Buffer.from(existingPath, 'base64');
    const prefixMatches = fileBuf.length >= dirBuf.length &&
      fileBuf.slice(0, dirBuf.length).equals(dirBuf);
    const atBoundary = fileBuf.length === dirBuf.length || fileBuf[dirBuf.length] === 0x2F;
    if (!prefixMatches || !atBoundary) continue;

    // If this path is no longer on disk, mark for removal
    if (!diskPaths.has(existingPath)) {
      staleIds.push(existingPath); // these are the base64 path values
    }
  }

  // Remove stale DB entries
  if (staleIds.length > 0) {
    console.log(`[Scanner] Removing ${staleIds.length} stale track(s) from ${dirPath}`);
    await deleteTracksByIds(staleIds);
  }

  // Determine truly new files (not already in DB)
  const newFileBufs = fileBufs.filter(b => !allExisting.has(b.toString('base64')));

  if (newFileBufs.length === 0 && staleIds.length === 0) {
    console.log(`[Scanner] No changes detected in ${dirPath}`);
    return { removed: staleIds.length, added: 0 };
  }

  if (newFileBufs.length > 0) {
    // ── Metadata ──
    scanStatus.phase = 'metadata';
    scanStatus.totalFiles = newFileBufs.length;
    scanStatus.scannedFiles = 0;
    scanStatus.currentFile = '';
    broadcastScanStatus(true);
    const metadataConcurrency = await getScannerConcurrency();
    await processMetadataBatch(newFileBufs, metadataConcurrency);
    console.log(`[Scanner] Metadata phase complete: ${newFileBufs.length} new file(s)`);

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
      console.log(`[Scanner] Analysis phase complete: ${tracksNeedingAnalysis.length} track(s) analyzed`);
    }
  }

  // Trigger Genre Matrix regeneration after any change
  if (newFileBufs.length > 0 || staleIds.length > 0) {
    setImmediate(() => {
      genreMatrixService.runDiffAndGenerate()
        .catch(e => console.error('[Genre Matrix] Post-scan categorization failed:', e));
    });
  }

  console.log(`[Scanner] Sync walk complete for ${dirPath}: +${newFileBufs.length} added, -${staleIds.length} removed`);
  return { removed: staleIds.length, added: newFileBufs.length };
}

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
    console.log(`[Scanner] Removed directory and tracks for ${dirPath}`);
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

    // Build a safe base64 LIKE prefix for a directory path.
    //
    // Base64 encodes 3 input bytes → 4 output chars. If the directory path is
    // NOT a multiple of 3 bytes, the last partial group gets encoded differently
    // depending on what follows it (i.e. the rest of the file path), so the
    // directory's base64 and a child file's base64 will DIVERGE for any chars
    // past the last complete 3-byte boundary.
    //
    // Fix: only base64-encode the first floor(len/3)×3 bytes. This produces a
    // prefix that is always a substring of every child file's base64 encoding.
    // The precise byte-level check below (prefixMatches + atBoundary) handles
    // the accurate filtering within the pre-filtered rows.
    const toLikePrefix = (dirPath: string) => {
      const bytes = Buffer.from(dirPath, 'utf8');
      const safeLen = Math.floor(bytes.length / 3) * 3; // last complete 3-byte group
      if (safeLen === 0) return ''; // path < 3 bytes — skip LIKE pre-filter
      return bytes.slice(0, safeLen).toString('base64') // no padding chars ever
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
    };

    const result = [];

    for (const dir of dirs) {
      const dirBuf = Buffer.from(dir, 'utf8');
      const likePrefix = toLikePrefix(dir);

      // SQL pre-filter using the safe base64 prefix (guaranteed to align to a
      // 3-byte base64 group boundary, so it reliably matches all child paths).
      // Falls back to a full scan when the prefix is too short to be useful.
      const tracksRes = likePrefix
        ? await db.query(`
            SELECT t.path,
                   t.artist IS NOT NULL AND t.artist != '' AS has_artist,
                   t.album IS NOT NULL AND t.album != '' AS has_album,
                   tf.track_id IS NOT NULL AS has_features
            FROM tracks t
            LEFT JOIN track_features tf ON t.id = tf.track_id
            WHERE t.path LIKE $1 || '%'
          `, [likePrefix])
        : await db.query(`
            SELECT t.path,
                   t.artist IS NOT NULL AND t.artist != '' AS has_artist,
                   t.album IS NOT NULL AND t.album != '' AS has_album,
                   tf.track_id IS NOT NULL AS has_features
            FROM tracks t
            LEFT JOIN track_features tf ON t.id = tf.track_id
          `);

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
