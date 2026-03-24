import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { addDirectory, addTrack, getAllTracks, getDirectories, removeDirectory, removeTracksByDirectory, getOrCreateArtist, getOrCreateAlbum, getOrCreateGenre, migrateEntityIds, getArtistById, getAlbumById, getGenreById, getAllArtists, getAllAlbums, getAllGenres, getTracksByArtist, getTracksByAlbum, getTracksByGenre } from './database';
import { extractAudioFeatures } from './services/audioExtraction.service';
import { generateHubConcepts, generateCustomPlaylist } from './services/llm.service';
import { getHubCollections, calculateNextInfinityTrack } from './services/recommendation.service';
import { genreMatrixService } from './services/genreMatrix.service';
import { getSystemSetting, setSystemSetting, getSubGenreMappings } from './database';
import * as mm from 'music-metadata';
import OpenAI from 'openai';
dotenv.config();
const app = express();
const port = process.env.PORT || 3001;
// Allowed origins setup
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'];
app.use(cors({
    origin: (origin, callback) => {
        // allow requests with no origin (like mobile apps or curl requests) if desired, but here we restrict or allow based on config
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));
app.use(express.json());
let cachedNeedsSetup = null;
const checkNeedsSetup = () => {
    if (cachedNeedsSetup !== null)
        return cachedNeedsSetup;
    const expectedUser = process.env.AUTH_USERNAME;
    const expectedPass = process.env.AUTH_PASSWORD;
    // If no auth is defined, or it's the exact default boilerplate, we need setup.
    if (!expectedUser || !expectedPass || expectedPass === 'changeme') {
        cachedNeedsSetup = true;
    }
    else {
        cachedNeedsSetup = false;
    }
    return cachedNeedsSetup;
};
// Basic Authentication Middleware
const requireAuth = (req, res, next) => {
    if (checkNeedsSetup()) {
        // If we are in setup mode, bypass auth so the frontend wizard can configure the server
        return next();
    }
    let b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    if (!b64auth && req.query.token) {
        b64auth = req.query.token;
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
async function isPathAllowed(requestedPathBuf) {
    const allowedDirs = await getDirectories();
    for (const dir of allowedDirs) {
        // Convert the directory string to raw UTF-8 bytes for a byte-level prefix comparison.
        const dirBuf = Buffer.from(path.resolve(dir), 'utf8');
        // Ensure we match on a directory boundary (add sep if missing)
        const sep = Buffer.from(path.sep);
        const dirWithSep = dirBuf[dirBuf.length - 1] === sep[0]
            ? dirBuf
            : Buffer.concat([dirBuf, sep]);
        if (requestedPathBuf.length >= dirWithSep.length &&
            requestedPathBuf.slice(0, dirWithSep.length).equals(dirWithSep)) {
            return true;
        }
    }
    return false;
}
// Convert a DB-stored Base64 path string back to the original raw byte Buffer.
// Base64 securely preserves all unencodable Linux bytes natively.
function pathToBuffer(p) {
    return Buffer.from(p, 'base64');
}
// Reverses the frontend's safeBtoa to recover the exact string sent by the client
function safeAtob(b64) {
    // 1. Decode base64 to get the URI-encoded payload (e.g. "Some%20Name%C3%B7")
    const uriStr = Buffer.from(b64, 'base64').toString('latin1');
    // 2. We parse the %XX hex codes manually into a raw byte array.
    // We do not use decodeURIComponent() because it assumes the resulting bytes form a valid UTF-8 string, 
    // and throws URIError if it encounters raw ISO-8859-1 bytes (like from a DB latin1 string).
    const bytes = [];
    for (let i = 0; i < uriStr.length; i++) {
        if (uriStr[i] === '%' && i + 2 < uriStr.length) {
            bytes.push(parseInt(uriStr.substring(i + 1, i + 3), 16));
            i += 2;
        }
        else {
            bytes.push(uriStr.charCodeAt(i));
        }
    }
    // 3. The raw bytes represent a UTF-8 encoded string (since the frontend called encodeURIComponent).
    // We decode those bytes as UTF-8 back to a standard Javascript String.
    return Buffer.from(bytes).toString('utf8');
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
        }
        else {
            envContent += `\nAUTH_USERNAME=${username}`;
        }
        if (envContent.includes('AUTH_PASSWORD=')) {
            envContent = envContent.replace(/AUTH_PASSWORD=.*/g, `AUTH_PASSWORD=${password}`);
        }
        else {
            envContent += `\nAUTH_PASSWORD=${password}`;
        }
        fs.writeFileSync(envPath, envContent.trim() + '\n');
        // Update active memory config so immediate API requests require the new auth
        process.env.AUTH_USERNAME = username;
        process.env.AUTH_PASSWORD = password;
        cachedNeedsSetup = false;
        res.json({ status: 'completed' });
    }
    catch (error) {
        console.error('Failed to complete setup:', error);
        res.status(500).json({ error: 'Failed to write credentials to server configuration.' });
    }
});
// API: Test LLM Connection
app.post('/api/health/llm', async (req, res) => {
    try {
        const { llmBaseUrl, llmApiKey } = req.body;
        const openai = new OpenAI({
            baseURL: llmBaseUrl || 'https://api.openai.com/v1',
            apiKey: llmApiKey || 'dummy-key',
        });
        // Just list models to test connection
        const modelsResponse = await openai.models.list();
        const models = modelsResponse.data.map((m) => m.id);
        res.json({ status: 'ok', models });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
// API: Get settings
app.get('/api/settings', async (req, res) => {
    try {
        const keys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'audioAnalysisCpu', 'hubGenerationSchedule', 'llmBaseUrl', 'llmApiKey', 'llmModelName', 'genreMatrixLastRun', 'genreMatrixLastResult', 'genreMatrixProgress'];
        const settings = {};
        for (const k of keys) {
            settings[k] = await getSystemSetting(k);
        }
        res.json(settings);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});
// API: Update settings
app.post('/api/settings', async (req, res) => {
    try {
        const settings = req.body;
        for (const [k, v] of Object.entries(settings)) {
            await setSystemSetting(k, v);
        }
        res.json({ status: 'updated' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update settings' });
    }
});
// API: Get Genre Mappings (for coverage stats)
app.get('/api/genre-matrix/mappings', async (req, res) => {
    try {
        const mappings = await getSubGenreMappings();
        res.json(mappings);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch mappings' });
    }
});
// API: Regenerate Genre Matrix
app.post('/api/genre-matrix/regenerate', async (req, res) => {
    try {
        // Non-blocking
        genreMatrixService.runDiffAndGenerate();
        res.json({ lastRun: Date.now(), lastResult: 'Categorization started...' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to start categorization' });
    }
});
// API: Full Re-mapping of all genres
app.post('/api/genre-matrix/remap-all', async (req, res) => {
    try {
        // Non-blocking
        genreMatrixService.remapAll();
        res.json({ status: 'started' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to start full remap' });
    }
});
// API: Stream Audio
// Supports HTTP Range requests for gapless playback, seeking, and Web Audio API
app.get('/api/stream', async (req, res) => {
    const b64Path = req.query.pathB64;
    const rawPath = req.query.path;
    if (!b64Path && !rawPath) {
        return res.status(400).send('Missing path parameter');
    }
    // Recover original raw bytes: The client base64-encodes the latin1 string 
    // using safeBtoa to prevent Javascript's URL encoding from mangling raw bytes.
    // We reverse safeBtoa to get back the latin1 string, then convert to Buffer.
    let dbPathStr = rawPath;
    if (b64Path) {
        dbPathStr = safeAtob(b64Path);
    }
    const fileBuf = pathToBuffer(dbPathStr);
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
    const ext = path.extname(fileBuf.toString('utf8')).slice(1).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'audio/mpeg';
    if (mimeType === 'audio/x-ms-wma') {
        // Transcode WMA to MP3 on the fly for browser compatibility (Chrome/Linux)
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'none'); // Crucial for Chrome to play from the start of a stream
        // Note: We skip range requests for on-the-fly transcoding to keep things simple and reliable.
        // ffmpeg will pipe the MP3 stream directly to the response.
        const ffmpeg = spawn('ffmpeg', [
            '-i', fileBuf.toString('utf8'), // ffmpeg usually handles raw paths fine if passed as args
            '-map', '0:a:0', // Explicitly take only the first audio stream
            '-vn', // Disable video/images (like embedded MJPEG cover art) to prevent output corruption
            '-c:a', 'libmp3lame',
            '-b:a', '192k',
            '-id3v2_version', '3', // Older but highly compatible ID3 tags for browsers
            '-fflags', '+genpts', // Generate missing timestamps for better stream processing
            '-f', 'mp3',
            '-'
        ]);
        // MUST consume stderr, otherwise FFmpeg will hang when its internal buffer fills up
        ffmpeg.stderr.on('data', (data) => {
            console.error('[FFmpeg]', data.toString());
        });
        ffmpeg.stdout.pipe(res);
        req.on('close', () => {
            ffmpeg.kill('SIGKILL'); // Force kill if the user stops playback / skips track
        });
        ffmpeg.on('error', (err) => {
            console.error('FFmpeg spawn error:', err);
            if (!res.headersSent)
                res.status(500).send('Transcoding error');
        });
        ffmpeg.on('exit', (code, signal) => {
            if (code !== 0 && code !== null) {
                console.error(`FFmpeg process exited with code ${code} and signal ${signal}`);
            }
        });
        return;
    }
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
            'Content-Type': mimeType,
        };
        res.writeHead(206, head);
        file.pipe(res);
    }
    else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': mimeType,
        };
        res.writeHead(200, head);
        fs.createReadStream(fileBuf).pipe(res);
    }
});
let scanStatus = {
    isScanning: false,
    phase: 'idle',
    scannedFiles: 0,
    totalFiles: 0,
    activeFiles: [],
    activeWorkers: 0,
    currentFile: '' // kept for backwards-compat
};
const scanClients = new Set();
let lastBroadcastTime = 0;
function broadcastScanStatus(force = false) {
    const now = Date.now();
    if (!force && now - lastBroadcastTime < 100)
        return;
    lastBroadcastTime = now;
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
const MIME_TYPES = {
    mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    wma: 'audio/x-ms-wma',
};
// ─── Phase 1: Recursive directory walk ──────────────────────────────────────
// Quickly collect all audio file path Buffers without doing any metadata work.
// Uses Buffer paths throughout to avoid encoding corruption.
async function collectAudioFiles(dirBuf, results = []) {
    const sep = Buffer.from(path.sep);
    let entries;
    try {
        entries = await fs.promises.readdir(dirBuf, { encoding: 'buffer' });
    }
    catch {
        return results; // skip unreadable dirs silently
    }
    await Promise.all(entries.map(async (nameBuffer) => {
        const fullBuf = Buffer.concat([
            dirBuf,
            dirBuf[dirBuf.length - 1] === sep[0] ? Buffer.alloc(0) : sep,
            nameBuffer,
        ]);
        let stat;
        try {
            stat = await fs.promises.stat(fullBuf);
        }
        catch {
            return; // skip unstateable entries
        }
        if (stat.isDirectory()) {
            await collectAudioFiles(fullBuf, results);
        }
        else if (stat.isFile() && nameBuffer.toString('utf8').match(/\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i)) {
            results.push(fullBuf);
        }
    }));
    return results;
}
// ─── Phase 2: Parallel metadata extraction ──────────────────────────────────
// Process up to CONCURRENCY files at the same time.
const SCAN_CONCURRENCY = 16;
async function processFileBatch(fileBufs) {
    let index = 0;
    // Track which filenames are actively being processed right now.
    const activeSet = new Set();
    async function worker() {
        scanStatus.activeWorkers++;
        broadcastScanStatus();
        try {
            while (true) {
                const i = index++;
                if (i >= fileBufs.length)
                    return;
                const fullBuf = fileBufs[i];
                // Base64 securely encodes ANY sequence of bytes (including invalid UTF-8) 
                // into a string that is 100% safe for JSON, API transit, and PostgreSQL storage.
                const dbPath = fullBuf.toString('base64');
                // We use raw UTF-8 interpretation purely for extracting a human-readable title 
                // and extension string. If invalid characters become , that's fine for UI display!
                const utf8StringPath = fullBuf.toString('utf8');
                const nameStr = path.basename(utf8StringPath);
                activeSet.add(nameStr);
                scanStatus.activeFiles = Array.from(activeSet);
                scanStatus.currentFile = nameStr;
                scanStatus.scannedFiles++;
                broadcastScanStatus();
                try {
                    const ext = nameStr.split('.').pop()?.toLowerCase() || '';
                    const mimeType = MIME_TYPES[ext] || 'audio/mpeg';
                    // Hack: music-metadata relies on string methods to extract the file extension,
                    // but we MUST pass a raw Buffer to fs.open to handle unencodable Linux bytes.
                    // By adding these methods to the Buffer instance, we satisfy music-metadata's parser
                    // router while natively delivering the exact raw bytes to the filesystem for instant random-access.
                    const fileBufHack = Buffer.from(fullBuf);
                    fileBufHack.lastIndexOf = (search) => nameStr.lastIndexOf(search);
                    fileBufHack.substring = (start, end) => nameStr.substring(start, end);
                    fileBufHack.toLowerCase = () => nameStr.toLowerCase();
                    const metadata = await mm.parseFile(fileBufHack);
                    let artists;
                    if (metadata.common.artists && metadata.common.artists.length > 0) {
                        artists = metadata.common.artists;
                    }
                    else if (metadata.common.artist) {
                        const splitRegex = /\s+(?:feat\.?|ft\.?|featuring|&)\s+(?!$)/i;
                        const parts = metadata.common.artist.split(splitRegex).map(s => s.trim()).filter(Boolean);
                        if (parts.length > 0)
                            artists = parts;
                    }
                    let audioFeatures;
                    try {
                        // The backend extraction needs the actual raw bytes for files with special characters on Linux
                        audioFeatures = await extractAudioFeatures(fullBuf);
                    }
                    catch (featureErr) {
                        console.error(`[Scanner] Recommendation Engine: Failed to extract audio features for "${nameStr}". This track will have limited discovery/AI support.`, featureErr);
                    }
                    // Resolve entity UUIDs for navigation
                    const albumArtistName = metadata.common.albumartist || metadata.common.artist || null;
                    const albumTitle = metadata.common.album || null;
                    const genreName = metadata.common.genre ? metadata.common.genre[0] : null;
                    let artistId = null;
                    let albumId = null;
                    let genreId = null;
                    try {
                        if (albumArtistName)
                            artistId = await getOrCreateArtist(albumArtistName);
                    }
                    catch (e) { /* skip */ }
                    // Also create entities for all individual artists (including featured)
                    if (artists) {
                        for (const a of artists) {
                            try {
                                await getOrCreateArtist(a);
                            }
                            catch (e) { /* skip */ }
                        }
                    }
                    try {
                        if (albumTitle)
                            albumId = await getOrCreateAlbum(albumTitle, albumArtistName);
                    }
                    catch (e) { /* skip */ }
                    try {
                        if (genreName)
                            genreId = await getOrCreateGenre(genreName);
                    }
                    catch (e) { /* skip */ }
                    await addTrack({
                        path: dbPath,
                        title: metadata.common.title || nameStr,
                        artist: metadata.common.artist || metadata.common.albumartist || null,
                        albumArtist: metadata.common.albumartist || null,
                        artists: artists || null,
                        album: albumTitle,
                        genre: genreName,
                        duration: metadata.format.duration || 0,
                        trackNumber: metadata.common.track.no || null,
                        year: metadata.common.year || null,
                        releaseType: metadata.common.releasetype ? metadata.common.releasetype[0] : null,
                        isCompilation: metadata.common.compilation || false,
                        bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
                        format: metadata.format.container || metadata.format.codec || null,
                        audioFeatures,
                        artistId,
                        albumId,
                        genreId
                    });
                    if (!metadata.common.genre || metadata.common.genre.length === 0) {
                        console.warn(`[Scanner] Recommendation Engine: No genre found for "${nameStr}". Hop-cost logic will be restricted.`);
                    }
                }
                catch (err) {
                    console.warn(`Failed to parse metadata for ${nameStr}`, err);
                    await addTrack({ path: dbPath, title: nameStr, bitrate: null, format: null });
                }
                finally {
                    activeSet.delete(nameStr);
                    scanStatus.activeFiles = Array.from(activeSet);
                    broadcastScanStatus();
                }
            }
        }
        finally {
            scanStatus.activeWorkers--;
            broadcastScanStatus(true);
        }
    }
    // Spawn up to SCAN_CONCURRENCY workers (but no more than there are files).
    const workerCount = Math.min(SCAN_CONCURRENCY, fileBufs.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
}
// API: Add a mapped folder to the database without scanning
app.post('/api/library/add', async (req, res) => {
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
    }
    catch (error) {
        console.error('Add mapping error:', error);
        res.status(500).json({ error: 'Failed to add directory mapping' });
    }
});
// API: Trigger a library scan for a given absolute directory path
app.post('/api/library/scan', async (req, res) => {
    console.log('Scan Request Received. Body:', JSON.stringify(req.body));
    const { path: dirPath } = req.body;
    if (!dirPath || typeof dirPath !== 'string') {
        console.log('Scan 400: Missing or invalid path', { dirPath, type: typeof dirPath });
        return res.status(400).json({ error: 'Missing absolute path parameter in body' });
    }
    if (!fs.existsSync(dirPath)) {
        console.log('Scan 400: Path does not exist', dirPath);
        return res.status(400).json({ error: 'Path does not exist' });
    }
    if (!fs.statSync(dirPath).isDirectory()) {
        console.log('Scan 400: Path is not a directory', dirPath);
        return res.status(400).json({ error: 'Path is not a directory' });
    }
    if (scanStatus.isScanning) {
        console.log('Scan 400: Scan already in progress');
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
        // Phase 1: Fast recursive walk to collect all audio file paths.
        const dirBuf = Buffer.from(dirPath, 'utf8');
        const fileBufs = await collectAudioFiles(dirBuf);
        if (fileBufs.length === 0) {
            console.warn(`[Scanner] No audio files found in ${dirPath}. Check permissions or file extensions.`);
        }
        // Phase 2: Parse metadata in parallel across SCAN_CONCURRENCY workers.
        scanStatus.phase = 'metadata';
        scanStatus.totalFiles = fileBufs.length;
        scanStatus.scannedFiles = 0;
        scanStatus.currentFile = '';
        broadcastScanStatus(true);
        await processFileBatch(fileBufs);
        console.log(`[Scanner] Scan completed for ${dirPath}: ${fileBufs.length} files processed`);
        // Trigger LLM Hub regeneration asynchronously after the scan finishes
        // This runs in the background and does not block the scan response
        setImmediate(() => {
            genreMatrixService.runDiffAndGenerate()
                .then(() => runLlmHubRegeneration())
                .catch(e => console.error('[LLM Hub] Post-scan generation failed:', e));
        });
        res.json({ status: 'completed', message: `Scan completed for ${dirPath}` });
    }
    catch (error) {
        console.error('Scan init error:', error);
        res.status(500).json({ error: 'Failed to complete scan' });
    }
    finally {
        scanStatus.isScanning = false;
        scanStatus.phase = 'idle';
        scanStatus.currentFile = '';
        scanStatus.activeFiles = [];
        scanStatus.activeWorkers = 0;
        broadcastScanStatus(true);
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
    }
    catch (error) {
        console.error('Remove error:', error);
        res.status(500).json({ error: 'Failed to remove directory' });
    }
});
// API: Get entire library
app.get('/api/library', async (req, res) => {
    try {
        const tracks = await getAllTracks();
        const directories = await getDirectories();
        // Include entity lookup data for frontend navigation
        const artists = await getAllArtists();
        const albums = await getAllAlbums();
        const genres = await getAllGenres();
        res.json({ tracks, directories, artists, albums, genres });
    }
    catch (error) {
        console.error('DB fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch library' });
    }
});
// API: Get all User and LLM Playlists
app.get('/api/playlists', async (req, res) => {
    try {
        const { getPlaylists, getPlaylistTracks } = await import('./database');
        const playlists = await getPlaylists();
        // Attach tracks to them for initial load
        const populated = await Promise.all(playlists.map(async (pl) => {
            const tracks = await getPlaylistTracks(pl.id);
            return { ...pl, tracks };
        }));
        res.json({ playlists: populated });
    }
    catch (error) {
        console.error('Playlist fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch playlists' });
    }
});
// API: Create new User Playlist
app.post('/api/playlists', async (req, res) => {
    try {
        const { title, description } = req.body;
        if (!title)
            return res.status(400).json({ error: 'Title required' });
        const { createPlaylist } = await import('./database');
        const id = `user_${Date.now()}`;
        await createPlaylist(id, title, description, false);
        res.json({ id, title, description, isLlmGenerated: false, tracks: [] });
    }
    catch (error) {
        console.error('Playlist create error:', error);
        res.status(500).json({ error: 'Failed to create playlist' });
    }
});
// API: Save tracks to a playlist
app.post('/api/playlists/:id/tracks', async (req, res) => {
    try {
        const { id } = req.params;
        const { trackIds } = req.body;
        if (!Array.isArray(trackIds))
            return res.status(400).json({ error: 'trackIds must be an array' });
        const { addTracksToPlaylist } = await import('./database');
        await addTracksToPlaylist(id, trackIds);
        res.json({ status: 'success' });
    }
    catch (error) {
        console.error('Playlist track update error:', error);
        res.status(500).json({ error: 'Failed to update playlist tracks' });
    }
});
// API: Delete a playlist
app.delete('/api/playlists/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { deletePlaylist } = await import('./database');
        await deletePlaylist(id);
        res.json({ status: 'deleted' });
    }
    catch (error) {
        console.error('Playlist delete error:', error);
        res.status(500).json({ error: 'Failed to delete playlist' });
    }
});
// API: Get Hub Data (READ-ONLY - assembles engine-driven + cached LLM collections)
// Does NOT call the LLM. Call /api/hub/regenerate to trigger fresh LLM generation explicitly.
app.get('/api/hub', async (req, res) => {
    try {
        const collections = await getHubCollections([]);
        res.json({ collections });
    }
    catch (error) {
        console.error('Hub fetch error:', error);
        res.status(500).json({ error: 'Failed to generate hub' });
    }
});
// Internal helper: generate LLM playlists if config is present and cache is stale
async function runLlmHubRegeneration(opts = {}) {
    const { getSystemSetting } = await import('./database');
    const llmBaseUrl = (await getSystemSetting('llmBaseUrl')) || process.env.LLM_BASE_URL || '';
    // Only skip if no base URL is configured at all — local LLMs don't need an API key
    if (!llmBaseUrl) {
        return { skipped: true, reason: 'No LLM base URL configured' };
    }
    const { getPlaylists, deleteOldLlmPlaylists } = await import('./database');
    // Cleanup stale LLM playlists to avoid database clutter
    // If forced (Reset Hub), we delete ALL LLM playlists (maxAgeMs = 0)
    const maxAgeMs = opts.force ? 0 : 24 * 60 * 60 * 1000;
    const deletedCount = await deleteOldLlmPlaylists(maxAgeMs);
    if (deletedCount && deletedCount > 0) {
        console.log(`[LLM Hub] ${opts.force ? 'Reset' : 'Cleaned up'} ${deletedCount} LLM playlist(s)`);
    }
    const existingPlaylists = await getPlaylists();
    // Determine age based on schedule using getSystemSetting('hubGenerationSchedule')
    // For now we enforce at least 4 hours if not forced
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const hasRecentLlm = existingPlaylists.some((pl) => pl.isllmgenerated && (Date.now() - pl.createdat) < fourHoursMs);
    if (hasRecentLlm && !opts.force) {
        return { skipped: true, reason: 'Recent LLM playlists exist (< 4h old)' };
    }
    const timeOfDay = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening';
    const concepts = await generateHubConcepts({ timeOfDay, historySummary: '' });
    if (concepts.length > 0) {
        // This does the vector search and writes playlists to the database
        await getHubCollections(concepts);
    }
    console.log(`[LLM Hub] Generated and saved ${concepts.length} playlist(s) for ${timeOfDay}`);
    return { generated: concepts.length };
}
// API: Trigger LLM Hub Regeneration explicitly (called after scan or from an admin action)
app.post('/api/hub/regenerate', async (req, res) => {
    try {
        const { force } = req.body;
        const result = await runLlmHubRegeneration({ force: !!force });
        res.json(result);
    }
    catch (error) {
        console.error('Hub regeneration error:', error);
        res.status(500).json({ error: 'Failed to regenerate hub' });
    }
});
// API: Generate a single custom playlist from a user prompt
app.post('/api/hub/generate-custom', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ error: 'A prompt is required' });
        }
        const concept = await generateCustomPlaylist(prompt.trim());
        if (!concept) {
            return res.status(503).json({ error: 'LLM did not return a valid playlist concept. Check your LLM configuration.' });
        }
        // Reuse the same vector search + DB write pipeline as automated playlists
        const saved = await getHubCollections([concept]);
        const playlist = saved.find(c => c.isLlmGenerated);
        res.json({ playlist });
    }
    catch (error) {
        console.error('Custom playlist generation error:', error);
        res.status(500).json({ error: 'Failed to generate custom playlist' });
    }
});
// API: Manually trigger genre matrix regeneration
app.post('/api/genre-matrix/regenerate', async (req, res) => {
    try {
        await genreMatrixService.runDiffAndGenerate();
        const { getSystemSetting } = await import('./database');
        const lastRun = await getSystemSetting('genreMatrixLastRun');
        const lastResult = await getSystemSetting('genreMatrixLastResult');
        res.json({ status: 'ok', lastRun, lastResult });
    }
    catch (error) {
        console.error('Genre matrix regeneration error:', error);
        res.status(500).json({ error: 'Failed to regenerate genre matrix' });
    }
});
// Schedule: Re-run LLM hub generation periodically
const LLM_HUB_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
setInterval(async () => {
    const { getSystemSetting } = await import('./database');
    const schedule = await getSystemSetting('hubGenerationSchedule') || 'Daily';
    if (schedule === 'Manual Only')
        return;
    console.log('[LLM Hub] Scheduled refresh check...');
    try {
        await runLlmHubRegeneration();
    }
    catch (e) {
        console.error('[LLM Hub] Scheduled refresh failed:', e);
    }
}, LLM_HUB_INTERVAL_MS);
// API: Request next infinity mode track
app.post('/api/recommend', async (req, res) => {
    try {
        const { sessionHistoryTrackIds, settings } = req.body;
        const nextTrack = await calculateNextInfinityTrack(sessionHistoryTrackIds || [], settings || {});
        res.json({ track: nextTrack });
    }
    catch (error) {
        console.error('Infinity recommendation error:', error);
        res.status(500).json({ error: 'Failed to compute next track' });
    }
});
// API: Record a successful playback
app.post('/api/playback/record', async (req, res) => {
    try {
        const { trackId } = req.body;
        if (!trackId)
            return res.status(400).json({ error: 'trackId required' });
        const { recordPlayback } = await import('./database');
        await recordPlayback(trackId);
        res.json({ status: 'recorded' });
    }
    catch (err) {
        console.error('Playback record error:', err);
        res.status(500).json({ error: 'Failed to record playback' });
    }
});
// API: Record a track skip
app.post('/api/playback/skip', async (req, res) => {
    try {
        const { trackId } = req.body;
        if (!trackId)
            return res.status(400).json({ error: 'trackId required' });
        const { recordSkip } = await import('./database');
        await recordSkip(trackId);
        res.json({ status: 'recorded' });
    }
    catch (err) {
        console.error('Skip record error:', err);
        res.status(500).json({ error: 'Failed to record skip' });
    }
});
// API: Entity endpoints for UUID-based navigation
app.get('/api/artists', async (req, res) => {
    try {
        const artists = await getAllArtists();
        res.json(artists);
    }
    catch (error) {
        console.error('Artists fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch artists' });
    }
});
app.get('/api/artists/:id', async (req, res) => {
    try {
        const artist = await getArtistById(req.params.id);
        if (!artist)
            return res.status(404).json({ error: 'Artist not found' });
        const tracks = await getTracksByArtist(req.params.id);
        res.json({ ...artist, tracks });
    }
    catch (error) {
        console.error('Artist fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch artist' });
    }
});
app.get('/api/albums', async (req, res) => {
    try {
        const albums = await getAllAlbums();
        res.json(albums);
    }
    catch (error) {
        console.error('Albums fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch albums' });
    }
});
app.get('/api/albums/:id', async (req, res) => {
    try {
        const album = await getAlbumById(req.params.id);
        if (!album)
            return res.status(404).json({ error: 'Album not found' });
        const tracks = await getTracksByAlbum(req.params.id);
        res.json({ ...album, tracks });
    }
    catch (error) {
        console.error('Album fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch album' });
    }
});
app.get('/api/genres', async (req, res) => {
    try {
        const genres = await getAllGenres();
        res.json(genres);
    }
    catch (error) {
        console.error('Genres fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch genres' });
    }
});
app.get('/api/genres/:id', async (req, res) => {
    try {
        const genre = await getGenreById(req.params.id);
        if (!genre)
            return res.status(404).json({ error: 'Genre not found' });
        const tracks = await getTracksByGenre(req.params.id);
        res.json({ ...genre, tracks });
    }
    catch (error) {
        console.error('Genre fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch genre' });
    }
});
// API: Get album art by track ID
app.get('/api/art', async (req, res) => {
    const b64Path = req.query.pathB64;
    const rawPath = req.query.path;
    if (!b64Path && !rawPath)
        return res.status(404).send('Not found');
    let dbPathStr = rawPath;
    if (b64Path) {
        dbPathStr = safeAtob(b64Path);
    }
    // Recover the original byte Buffer from the latin1 DB path string.
    const fileBuf = pathToBuffer(dbPathStr);
    if (!fs.existsSync(fileBuf)) {
        return res.status(404).send('Not found');
    }
    const allowed = await isPathAllowed(fileBuf);
    if (!allowed) {
        return res.status(403).send('Forbidden: Path is outside allowed library directories');
    }
    try {
        const utf8Path = fileBuf.toString('utf8');
        const ext = utf8Path.split('.').pop()?.toLowerCase() || '';
        const mimeType = MIME_TYPES[ext] || 'audio/mpeg';
        // Same hack as scanner to read the file utilizing the raw Buffer correctly
        const fileBufHack = Buffer.from(fileBuf);
        fileBufHack.lastIndexOf = (search) => utf8Path.lastIndexOf(search);
        fileBufHack.substring = (start, end) => utf8Path.substring(start, end);
        fileBufHack.toLowerCase = () => utf8Path.toLowerCase();
        const metadata = await mm.parseFile(fileBufHack);
        const picture = metadata.common.picture && metadata.common.picture[0];
        if (picture) {
            res.setHeader('Content-Type', picture.format);
            res.send(picture.data);
        }
        else {
            res.status(404).send('No art found');
        }
    }
    catch (err) {
        res.status(500).send('Error reading metadata');
    }
});
// API: Check Health (reports DB connectivity)
let dbConnected = false;
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', dbConnected, message: 'Aurora Media Server is running!' });
});
// Start server always, even if DB is unavailable.
// genreMatrixService.init() is attempted once; if it fails, dbConnected stays false.
app.listen(port, () => {
    console.log(`Aurora Media Server listening at http://localhost:${port}`);
});
genreMatrixService.init().then(async () => {
    dbConnected = true;
    console.log('[DB] Connected and genre matrix initialized.');
    // Backfill entity IDs for existing tracks
    try {
        await migrateEntityIds();
    }
    catch (e) {
        console.error('[DB] Entity migration failed (non-fatal):', e.message || e);
    }
}).catch(e => {
    dbConnected = false;
    console.error('[DB] Failed to connect — server is running but database is unavailable.', e.message || e);
});
