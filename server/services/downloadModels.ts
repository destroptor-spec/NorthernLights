import fs from 'fs';
import path from 'path';
import https from 'https';
import { EventEmitter } from 'events';

export const MODELS_DIR = path.join(__dirname, '..', 'models');

const EFFNET_URL = 'https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb';
const HEADS_URL = 'https://essentia.upf.edu/models/classification-heads';

// Discogs-EffNet is the only network; the rest are small classifiers on its
// per-patch embeddings (filenames must match server/workers/extractor.py).
// MusiCNN was dropped in feature version 3: these classifiers replaced its
// acoustic/instrumental/danceability tags at ~1 % of the CPU cost.
const MODELS = [
  { name: 'Discogs-EffNet', filename: 'discogs-effnet-bs64-1.pb', url: EFFNET_URL },
  { name: 'Discogs-400 styles', filename: 'genre_discogs400-discogs-effnet-1.pb', url: `${HEADS_URL}/genre_discogs400/genre_discogs400-discogs-effnet-1.pb` },
  { name: 'Danceability', filename: 'danceability-discogs-effnet-1.pb', url: `${HEADS_URL}/danceability/danceability-discogs-effnet-1.pb` },
  { name: 'Acoustic', filename: 'mood_acoustic-discogs-effnet-1.pb', url: `${HEADS_URL}/mood_acoustic/mood_acoustic-discogs-effnet-1.pb` },
  { name: 'Voice / instrumental', filename: 'voice_instrumental-discogs-effnet-1.pb', url: `${HEADS_URL}/voice_instrumental/voice_instrumental-discogs-effnet-1.pb` },
];
const MIN_MODEL_BYTES = 1000;

export interface ModelFile {
  name: string;
  dir: string;
  filename: string;
  url: string;
  size: number;
  cached: boolean;
  downloading: boolean;
  error?: string;
}

export interface ModelProgress {
  model: string;
  file: string;
  status: 'pending' | 'downloading' | 'done' | 'error' | 'verifying' | 'extracting';
  bytesDownloaded: number;
  totalBytes: number;
  error?: string;
}

export const modelProgressEmitter = new EventEmitter();
let isDownloading = false;

function downloadFile(url: string, dest: string, onProgress: (bytes: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doDownload = (downloadUrl: string) => {
      https.get(downloadUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          response.resume();
          if (!response.headers.location) return reject(new Error('Model download redirect was missing a location.'));
          return doDownload(response.headers.location!);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${response.statusCode}: ${downloadUrl}`));
        }
        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const file = fs.createWriteStream(dest);
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          onProgress(downloaded, totalBytes);
        });
        response.pipe(file);
        file.on('finish', () => file.close(error => error ? reject(error) : resolve()));
        file.on('error', (err) => {
          file.close();
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          reject(err);
        });
        response.on('error', reject);
      }).on('error', reject);
    };
    doDownload(url);
  });
}

function emitProgress(progress: ModelProgress) {
  modelProgressEmitter.emit('progress', progress);
}

export async function getModelStatus(): Promise<{ name: string; dir: string; files: ModelFile[] }[]> {
  const status = [];
  for (const model of MODELS) {
    const dest = path.join(MODELS_DIR, model.filename);
    const tempDest = `${dest}.part`;
    let size = 0;
    let cached = false;
    try {
      if (fs.existsSync(dest)) {
        const stat = fs.statSync(dest);
        size = stat.size;
        cached = size > MIN_MODEL_BYTES; // .pb files are several MB
      }
    } catch {}
    status.push({
      name: model.name,
      dir: MODELS_DIR,
      files: [{
        name: model.name,
        dir: MODELS_DIR,
        filename: model.filename,
        url: model.url,
        size,
        cached,
        downloading: isDownloading && fs.existsSync(tempDest)
      }]
    });
  }
  return status;
}

export async function areAnalysisModelsReady(): Promise<boolean> {
  const status = await getModelStatus();
  return status.length > 0 && status.every(model => model.files.every(file => file.cached));
}

export async function downloadModels(force = false): Promise<void> {
  if (isDownloading) return;
  
  // Check if already cached
  const status = await getModelStatus();
  if (!force && status.every(m => m.files.every(f => f.cached))) {
    return;
  }

  isDownloading = true;
  const failures: string[] = [];

  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true });

    for (const model of MODELS) {
      const dest = path.join(MODELS_DIR, model.filename);
      const tempDest = `${dest}.part`;

      // Skip if already downloaded
      if (!force && fs.existsSync(dest) && fs.statSync(dest).size > MIN_MODEL_BYTES) {
        emitProgress({ model: model.name, file: model.filename, status: 'done', bytesDownloaded: fs.statSync(dest).size, totalBytes: fs.statSync(dest).size });
        continue;
      }

      try {
        if (fs.existsSync(tempDest)) fs.unlinkSync(tempDest);
      } catch {}

      emitProgress({ model: model.name, file: model.filename, status: 'downloading', bytesDownloaded: 0, totalBytes: 0 });

      try {
        await downloadFile(model.url, tempDest, (bytes, total) => {
          emitProgress({ model: model.name, file: model.filename, status: 'downloading', bytesDownloaded: bytes, totalBytes: total });
        });
        const downloadedSize = fs.statSync(tempDest).size;
        if (downloadedSize <= MIN_MODEL_BYTES) throw new Error('Downloaded model file was incomplete.');
        // Keep a known-good model in place until its replacement is complete.
        // rename is atomic on the deployment filesystem used by Aurora.
        fs.renameSync(tempDest, dest);
        emitProgress({ model: model.name, file: model.filename, status: 'done', bytesDownloaded: fs.statSync(dest).size, totalBytes: fs.statSync(dest).size });
        console.log(`[Models] Downloaded ${model.name} → ${model.filename}`);
      } catch (err: any) {
        try { if (fs.existsSync(tempDest)) fs.unlinkSync(tempDest); } catch {}
        console.error(`[Models] Failed to download ${model.name}:`, err.message);
        emitProgress({ model: model.name, file: model.filename, status: 'error', bytesDownloaded: 0, totalBytes: 0, error: err.message });
        failures.push(`${model.name}: ${err.message}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  } catch (err: any) {
    console.error('[Models] Download error:', err.message);
    throw err;
  } finally {
    isDownloading = false;
  }
}

export async function clearAndRedownloadModels(): Promise<void> {
  // Remove abandoned partials, but keep known-good models in place until each
  // replacement has downloaded completely and can be atomically promoted.
  for (const model of MODELS) {
    const dest = path.join(MODELS_DIR, model.filename);
    try {
      if (fs.existsSync(`${dest}.part`)) fs.unlinkSync(`${dest}.part`);
    } catch {}
  }
  // Also clean up legacy tfjs directory if it exists
  const tfjsDir = path.join(MODELS_DIR, 'tfjs');
  try {
    if (fs.existsSync(tfjsDir)) {
      fs.rmSync(tfjsDir, { recursive: true, force: true });
    }
  } catch {}
  await downloadModels(true);
}

export function isDownloadInProgress(): boolean {
  return isDownloading;
}
