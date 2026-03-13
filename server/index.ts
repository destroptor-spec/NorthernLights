import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { addDirectory, addTrack, getAllTracks, getDirectories, removeDirectory, removeTracksByDirectory } from './libraryDB';
import * as mm from 'music-metadata';
import { Response, Request, NextFunction } from 'express';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Allowed origins setup
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'];
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // allow requests with no origin (like mobile apps or curl requests) if desired, but here we restrict or allow based on config
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json());

let cachedNeedsSetup: boolean | null = null;
const checkNeedsSetup = (): boolean => {
  if (cachedNeedsSetup !== null) return cachedNeedsSetup;
  const expectedUser = process.env.AUTH_USERNAME;
  const expectedPass = process.env.AUTH_PASSWORD;
  // If no auth is defined, or it's the exact default boilerplate, we need setup.
  if (!expectedUser || !expectedPass || expectedPass === 'changeme') {
    cachedNeedsSetup = true;
  } else {
    cachedNeedsSetup = false;
  }
  return cachedNeedsSetup;
};

// Basic Authentication Middleware
const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (checkNeedsSetup()) {
      // If we are in setup mode, bypass auth so the frontend wizard can configure the server
      return next();
  }

  let b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  if (!b64auth && req.query.token) {
    b64auth = req.query.token as string;
  }

  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  const expectedUser = process.env.AUTH_USERNAME || 'admin';
  const expectedPass = process.env.AUTH_PASSWORD || 'changeme';

  if (login && password && login === expectedUser && password === expectedPass) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Aurora Media Server"');
  res.status(401).send('Authentication required.');
};

// Security: Check if a raw-byte path Buffer resides within an allowed directory.
// Allowed dirs are typed as UTF-8 strings; file paths are raw byte Buffers.
async function isPathAllowed(requestedPathBuf: Buffer): Promise<boolean> {
  const allowedDirs = await getDirectories();
  for (const dir of allowedDirs) {
    // Convert the directory string to raw UTF-8 bytes for a byte-level prefix comparison.
    const dirBuf = Buffer.from(path.resolve(dir), 'utf8');
    // Ensure we match on a directory boundary (add sep if missing)
    const sep = Buffer.from(path.sep);
    const dirWithSep = dirBuf[dirBuf.length - 1] === sep[0]
      ? dirBuf
      : Buffer.concat([dirBuf, sep]);
    if (
      requestedPathBuf.length >= dirWithSep.length &&
      requestedPathBuf.slice(0, dirWithSep.length).equals(dirWithSep)
    ) {
      return true;
    }
  }
  return false;
}

// Convert a DB-stored latin1 path string back to the original raw byte Buffer.
// latin1 is byte-transparent: each byte 0x00-0xFF maps 1:1 to a JS code point,
// so Buffer.from(str, 'latin1') perfectly inverts Buffer.toString('latin1').
function pathToBuffer(p: string): Buffer {
  return Buffer.from(p, 'latin1');
}

// Ensure ALL API routes are protected (except public health/setup checks if necessary, but requireAuth handles setup bypass)
app.use((req, res, next) => {
  // Allow unprotected access to setup status so frontend knows if it should mount the wizard
  if (req.path === '/api/setup/status') {
    return next();
  }
  if (req.path.startsWith('/api')) {
    return requireAuth(req, res, next);
  }
  next();
});

// Setup API Routes
app.get('/api/setup/status', (req, res) => {
  res.json({ needsSetup: checkNeedsSetup() });
});

app.post('/api/setup/complete', (req, res) => {
  if (!checkNeedsSetup()) {
    return res.status(403).json({ error: 'Setup is already complete. You must edit .env manually to change credentials.' });
  }

  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 5) {
    return res.status(400).json({ error: 'Invalid username or password. Ensure they are strong.' });
  }

  try {
    // Write new credentials to .env file natively
    const envPath = path.resolve(__dirname, '../.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Replace or append AUTH params
    if (envContent.includes('AUTH_USERNAME=')) {
      envContent = envContent.replace(/AUTH_USERNAME=.*/g, `AUTH_USERNAME=${username}`);
    } else {
      envContent += `\nAUTH_USERNAME=${username}`;
    }

    if (envContent.includes('AUTH_PASSWORD=')) {
      envContent = envContent.replace(/AUTH_PASSWORD=.*/g, `AUTH_PASSWORD=${password}`);
    } else {
      envContent += `\nAUTH_PASSWORD=${password}`;
    }

    fs.writeFileSync(envPath, envContent.trim() + '\n');
    
    // Update active memory config so immediate API requests require the new auth
    process.env.AUTH_USERNAME = username;
    process.env.AUTH_PASSWORD = password;
    cachedNeedsSetup = false;

    res.json({ status: 'completed' });
  } catch (error) {
    console.error('Failed to complete setup:', error);
    res.status(500).json({ error: 'Failed to write credentials to server configuration.' });
  }
});

// API: Check Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Aurora Media Server is running!' });
});

// API: Stream Audio
// Supports HTTP Range requests for gapless playback, seeking, and Web Audio API
app.get('/api/stream', async (req, res) => {
  const rawPath = req.query.path as string;

  if (!rawPath) {
    return res.status(400).send('Missing path parameter');
  }

  // Recover original raw bytes: DB stored path as latin1 (byte-transparent).
  // Node fs functions accept Buffer paths and pass bytes unchanged to the kernel.
  const fileBuf = pathToBuffer(rawPath);

  // Security: Check if file exists AND path is allowed
  if (!fs.existsSync(fileBuf)) {
    return res.status(404).send('File not found');
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    return res.status(403).send('Forbidden: Path is outside allowed library directories');
  }

  const stat = fs.statSync(fileBuf);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(fileBuf, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'audio/mpeg',
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg',
    };
    res.writeHead(200, head);
    fs.createReadStream(fileBuf).pipe(res);
  }
});



let scanStatus = {
  isScanning: false,
  phase: 'idle' as 'idle' | 'walk' | 'metadata',
  scannedFiles: 0,
  totalFiles: 0,
  activeFiles: [] as string[],
  activeWorkers: 0,
  currentFile: '' // kept for backwards-compat
};
const scanClients = new Set<Response>();

function broadcastScanStatus() {
  const msg = `data: ${JSON.stringify(scanStatus)}\n\n`;
  scanClients.forEach(c => c.write(msg));
}

app.get('/api/library/scan/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  scanClients.add(res);
  res.write(`data: ${JSON.stringify(scanStatus)}\n\n`);

  req.on('close', () => {
    scanClients.delete(res);
  });
});

// Mime type map for parseStream
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
};

// ─── Phase 1: Recursive directory walk ──────────────────────────────────────
// Quickly collect all audio file path Buffers without doing any metadata work.
// Uses Buffer paths throughout to avoid encoding corruption.
async function collectAudioFiles(dirBuf: Buffer, results: Buffer[] = []): Promise<Buffer[]> {
  const sep = Buffer.from(path.sep);
  let entries: Buffer[];
  try {
    entries = await fs.promises.readdir(dirBuf, { encoding: 'buffer' });
  } catch {
    return results; // skip unreadable dirs silently
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
      return; // skip unstateable entries
    }
    if (stat.isDirectory()) {
      await collectAudioFiles(fullBuf, results);
    } else if (stat.isFile() && nameBuffer.toString('utf8').match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)) {
      results.push(fullBuf);
    }
  }));

  return results;
}

// ─── Phase 2: Parallel metadata extraction ──────────────────────────────────
// Process up to CONCURRENCY files at the same time.
const SCAN_CONCURRENCY = 16;

async function processFileBatch(fileBufs: Buffer[]): Promise<void> {
  let index = 0;
  // Track which filenames are actively being processed right now.
  const activeSet = new Set<string>();

  async function worker() {
    scanStatus.activeWorkers++;
    broadcastScanStatus();
    try {
      while (true) {
        const i = index++;
        if (i >= fileBufs.length) return;

        const fullBuf = fileBufs[i];
        const dbPath = fullBuf.toString('latin1');
        const nameStr = path.basename(fullBuf.toString('utf8'));

        activeSet.add(nameStr);
        scanStatus.activeFiles = Array.from(activeSet);
        scanStatus.currentFile = nameStr;
        scanStatus.scannedFiles++;
        broadcastScanStatus();

        try {
          const ext = nameStr.split('.').pop()?.toLowerCase() || '';
          const mimeType = MIME_TYPES[ext] || 'audio/mpeg';
          const fileStream = fs.createReadStream(fullBuf);
          const metadata = await mm.parseStream(fileStream, { mimeType });
          fileStream.destroy();

          let artists: string[] | undefined;
          if (metadata.common.artists && metadata.common.artists.length > 0) {
            artists = metadata.common.artists;
          } else if (metadata.common.artist) {
            const splitRegex = /\s+(?:feat\.?|ft\.?|featuring|&)\s+(?!$)/i;
            const parts = metadata.common.artist.split(splitRegex).map(s => s.trim()).filter(Boolean);
            if (parts.length > 0) artists = parts;
          }

          await addTrack({
            path: dbPath,
            title: metadata.common.title || nameStr,
            artist: metadata.common.artist || metadata.common.albumartist || null,
            albumArtist: metadata.common.albumartist || null,
            artists: artists || null,
            album: metadata.common.album || null,
            genre: metadata.common.genre ? metadata.common.genre[0] : null,
            duration: metadata.format.duration || 0,
            trackNumber: metadata.common.track.no || null,
            year: metadata.common.year || null,
            releaseType: metadata.common.releasetype ? metadata.common.releasetype[0] : null,
            isCompilation: metadata.common.compilation || false,
          });
        } catch (err) {
          console.warn(`Failed to parse metadata for ${nameStr}`, err);
          await addTrack({ path: dbPath, title: nameStr });
        } finally {
          activeSet.delete(nameStr);
          scanStatus.activeFiles = Array.from(activeSet);
          broadcastScanStatus();
        }
      }
    } finally {
      scanStatus.activeWorkers--;
      broadcastScanStatus();
    }
  }

  // Spawn up to SCAN_CONCURRENCY workers (but no more than there are files).
  const workerCount = Math.min(SCAN_CONCURRENCY, fileBufs.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

// API: Trigger a library scan for a given absolute directory path
app.post('/api/library/scan', async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter in body' });
  }

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: 'Path does not exist or is not a directory' });
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
    broadcastScanStatus();

    await addDirectory(dirPath);

    // Phase 1: Fast recursive walk to collect all audio file paths.
    const dirBuf = Buffer.from(dirPath, 'utf8');
    const fileBufs = await collectAudioFiles(dirBuf);

    // Phase 2: Parse metadata in parallel across SCAN_CONCURRENCY workers.
    scanStatus.phase = 'metadata';
    scanStatus.totalFiles = fileBufs.length;
    scanStatus.scannedFiles = 0;
    scanStatus.currentFile = '';
    broadcastScanStatus();
    await processFileBatch(fileBufs);
    console.log(`Scan completed for ${dirPath}: ${fileBufs.length} files`);

    res.json({ status: 'completed', message: `Scan completed for ${dirPath}` });
  } catch (error) {
    console.error('Scan init error:', error);
    res.status(500).json({ error: 'Failed to complete scan' });
  } finally {
    scanStatus.isScanning = false;
    scanStatus.phase = 'idle';
    scanStatus.currentFile = '';
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    broadcastScanStatus();
  }
});

// API: Remove a mapped folder and its tracks from the database
app.post('/api/library/remove', async (req, res) => {
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

// API: Get entire library
app.get('/api/library', async (req, res) => {
  try {
    const tracks = await getAllTracks();
    const directories = await getDirectories();
    res.json({ tracks, directories });
  } catch (error) {
    console.error('DB fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch library' });
  }
});

// API: Get album art by track ID
app.get('/api/art', async (req, res) => {
  const rawPath = req.query.path as string;
  if (!rawPath) return res.status(404).send('Not found');

  // Recover the original byte Buffer from the latin1 DB path string.
  const fileBuf = pathToBuffer(rawPath);
  if (!fs.existsSync(fileBuf)) {
    return res.status(404).send('Not found');
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    return res.status(403).send('Forbidden: Path is outside allowed library directories');
  }

  try {
    // Use parseStream with a Buffer-sourced ReadStream to avoid path encoding issues.
    const ext = rawPath.split('.').pop()?.toLowerCase() || '';
    const mimeType = MIME_TYPES[ext] || 'audio/mpeg';
    const fileStream = fs.createReadStream(fileBuf);
    const metadata = await mm.parseStream(fileStream, { mimeType });
    fileStream.destroy();
    const picture = metadata.common.picture && metadata.common.picture[0];

    if (picture) {
      res.setHeader('Content-Type', picture.format);
      res.send(picture.data);
    } else {
      res.status(404).send('No art found');
    }
  } catch (err) {
    res.status(500).send('Error reading metadata');
  }
});

app.listen(port, () => {
  console.log(`Aurora Media Server listening at http://localhost:${port}`);
});
