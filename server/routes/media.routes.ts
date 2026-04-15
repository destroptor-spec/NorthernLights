import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import * as mm from 'music-metadata';
import { isPathAllowed, pathToBuffer } from '../state';
import { initDB } from '../database';
import {
  getOrCreateHlsSession,
  touchSession,
  getSessionOutputDir,
  findSessionByTrackId,
  cleanupSession,
} from '../services/hlsStream.service';

const router = Router();

// Mime type map
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

// ─── HLS Streaming ─────────────────────────────────────────────────────

// Serve HLS playlist for a track
router.get('/stream/:trackId/playlist.m3u8', async (req, res) => {
  const { trackId } = req.params;
  const quality = (req.query.quality as string) || '128k';

  try {
    let fileBuf: Buffer;
    let bitrate: number | null = null;
    
    // Check if the trackId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (uuidRegex.test(trackId)) {
      // Look up the track from the database
      const db = await initDB();
      const result = await db.query('SELECT path, bitrate FROM tracks WHERE id = $1', [trackId]);
      if (result.rows.length === 0) {
        return res.status(404).send('Track not found');
      }
      fileBuf = pathToBuffer(result.rows[0].path);
      bitrate = result.rows[0].bitrate;
    } else {
      // trackId is base64(dbPath), where dbPath is itself base64(filesystemPath).
      // decodeURIComponent undoes URL encoding, then we decode one layer of base64
      // to recover the DB path string, which pathToBuffer decodes to the raw file path.
      const dbPath = Buffer.from(decodeURIComponent(trackId), 'base64').toString();
      fileBuf = pathToBuffer(dbPath);
    }

    if (!fs.existsSync(fileBuf)) {
      return res.status(404).send('Audio file not found on disk');
    }

    const allowed = await isPathAllowed(fileBuf);
    if (!allowed) {
      return res.status(403).send('Forbidden: Path is outside allowed library directories');
    }

    // Get or create the HLS session (waits for first segment to be ready)
    const session = await getOrCreateHlsSession(trackId, fileBuf, quality, bitrate);

    if (!fs.existsSync(session.playlistPath)) {
      return res.status(500).send('HLS playlist generation failed');
    }

    // Clean up session when client disconnects
    req.on('close', () => {
      // Don't immediately clean up — other clients may be using the same session
      // The TTL cleanup will handle it
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache'); // Playlist should always be fresh
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(session.playlistPath).pipe(res);
  } catch (err: any) {
    console.error('[HLS] Playlist error:', err?.message || err);
    if (!res.headersSent) {
      if (err?.code === 'ENOENT' || err?.message?.includes('ENOENT')) {
        res.status(501).send('FFmpeg not installed — HLS streaming unavailable');
      } else {
        res.status(500).send('HLS streaming error');
      }
    }
  }
});

// Serve individual HLS segments (.ts files)
router.get('/stream/:trackId/:segment', async (req, res) => {
  const { trackId, segment } = req.params;
  const quality = (req.query.quality as string) || '128k';

  // Only serve .ts segment files
  if (!segment.endsWith('.ts')) {
    return res.status(400).send('Invalid segment request');
  }

  // Try exact quality match first, then fallback to any session for this trackId.
  // hls.js doesn't forward query params on segment requests, so quality may be missing.
  let outputDir = getSessionOutputDir(trackId, quality);
  if (!outputDir) {
    const found = findSessionByTrackId(trackId);
    if (found) {
      outputDir = found.outputDir;
    }
  }

  if (!outputDir) {
    return res.status(404).send('No active HLS session for this track');
  }

  const segmentPath = path.join(outputDir, segment);
  if (!fs.existsSync(segmentPath)) {
    return res.status(404).send('Segment not found');
  }

  // Touch the session to keep it alive
  touchSession(trackId, quality);

  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Chunks never change
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(segmentPath).pipe(res);
});

// ─── Legacy Streaming ──────────────────────────────────────────────────

// Stream audio (supports Range requests)
router.get('/stream', async (req, res) => {
  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;

  if (!b64Path && !rawPath) {
    return res.status(400).send('Missing path parameter');
  }

  // pathB64 is the DB base64 path, URL-encoded by the frontend.
  // decodeURIComponent undoes the URL-encoding; the result is the raw DB base64 string.
  const dbPathStr = b64Path ? decodeURIComponent(b64Path) : rawPath;

  const fileBuf = pathToBuffer(dbPathStr);

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
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'none');

    const ffmpeg = spawn('ffmpeg', [
      '-i', fileBuf.toString('utf8'),
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-id3v2_version', '3',
      '-fflags', '+genpts',
      '-f', 'mp3',
      '-'
    ]);

    ffmpeg.stderr.on('data', (data) => {
      console.error('[FFmpeg]', data.toString());
    });

    ffmpeg.stdout.pipe(res);

    req.on('close', () => {
      ffmpeg.kill('SIGKILL');
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(501).send('FFmpeg not installed — WMA playback unavailable');
        } else {
          res.status(500).send('Transcoding error');
        }
      }
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
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
    };
    res.writeHead(200, head);
    fs.createReadStream(fileBuf).pipe(res);
  }
});

// Get album art by track path
router.get('/art', async (req, res) => {
  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;

  if (!b64Path && !rawPath) return res.status(404).send('Not found');

  const dbPathStr = b64Path ? decodeURIComponent(b64Path) : rawPath;

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
    const metadata = await mm.parseFile(utf8Path);
    const picture = metadata.common.picture?.[0];

    if (picture) {
      // Sanitize Content-Type: WMA files can embed malformed format strings
      // containing non-ASCII/control characters that crash Node's setHeader.
      const validMime = /^[\x20-\x7E]+$/.test(picture.format) ? picture.format : 'image/jpeg';
      res.setHeader('Content-Type', validMime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(picture.data);
    } else {
      res.status(404).send('No art found');
    }
  } catch (err: any) {
    console.error('[Art] Error reading embedded art:', err?.message || err);
    res.status(500).send('Error reading metadata');
  }
});

export default router;
