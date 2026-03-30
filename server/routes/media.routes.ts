import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import * as mm from 'music-metadata';
import { isPathAllowed, pathToBuffer, safeAtob } from '../state';

const router = Router();

// Mime type map
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

// Stream audio (supports Range requests)
router.get('/stream', async (req, res) => {
  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;

  if (!b64Path && !rawPath) {
    return res.status(400).send('Missing path parameter');
  }

  let dbPathStr = rawPath;
  if (b64Path) {
    dbPathStr = safeAtob(b64Path);
  }

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

  let dbPathStr = rawPath;
  if (b64Path) {
    dbPathStr = safeAtob(b64Path);
  }

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

    const fileBufHack = Buffer.from(fileBuf) as any;
    fileBufHack.lastIndexOf = (search: string) => utf8Path.lastIndexOf(search);
    fileBufHack.substring = (start: number, end?: number) => utf8Path.substring(start, end);
    fileBufHack.toLowerCase = () => utf8Path.toLowerCase();

    const metadata = await mm.parseFile(fileBufHack);
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

export default router;
