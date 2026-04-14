import fs from 'fs';
import path from 'path';
import https from 'https';
import { EventEmitter } from 'events';

export const MODELS_DIR = path.join(__dirname, '..', 'models');

const MUSICNN_URL = 'https://essentia.upf.edu/models/feature-extractors/musicnn/msd-musicnn-1.pb';
const EFFNET_URL = 'https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb';

const MODELS = [
  { name: 'MusiCNN', filename: 'msd-musicnn-1.pb', url: MUSICNN_URL },
  { name: 'Discogs-EffNet', filename: 'discogs-effnet-bs64-1.pb', url: EFFNET_URL }
];

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
          return doDownload(response.headers.location!);
        }
        if (response.statusCode !== 200) {
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
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { file.close(); if (fs.existsSync(dest)) fs.unlinkSync(dest); reject(err); });
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
    let size = 0;
    let cached = false;
    try {
      if (fs.existsSync(dest)) {
        const stat = fs.statSync(dest);
        size = stat.size;
        cached = size > 1000; // .pb files are several MB
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
        downloading: false
      }]
    });
  }
  return status;
}

export async function downloadModels(): Promise<void> {
  if (isDownloading) return;
  
  // Check if already cached
  const status = await getModelStatus();
  if (status.every(m => m.files.every(f => f.cached))) {
    return;
  }

  isDownloading = true;

  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true });

    for (const model of MODELS) {
      const dest = path.join(MODELS_DIR, model.filename);

      // Skip if already downloaded
      if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
        emitProgress({ model: model.name, file: model.filename, status: 'done', bytesDownloaded: fs.statSync(dest).size, totalBytes: fs.statSync(dest).size });
        continue;
      }

      emitProgress({ model: model.name, file: model.filename, status: 'downloading', bytesDownloaded: 0, totalBytes: 0 });

      try {
        await downloadFile(model.url, dest, (bytes, total) => {
          emitProgress({ model: model.name, file: model.filename, status: 'downloading', bytesDownloaded: bytes, totalBytes: total });
        });
        emitProgress({ model: model.name, file: model.filename, status: 'done', bytesDownloaded: fs.statSync(dest).size, totalBytes: fs.statSync(dest).size });
        console.log(`[Models] Downloaded ${model.name} → ${model.filename}`);
      } catch (err: any) {
        console.error(`[Models] Failed to download ${model.name}:`, err.message);
        emitProgress({ model: model.name, file: model.filename, status: 'error', bytesDownloaded: 0, totalBytes: 0, error: err.message });
      }
    }
  } catch (err: any) {
    console.error('[Models] Download error:', err.message);
  } finally {
    isDownloading = false;
  }
}

export async function clearAndRedownloadModels(): Promise<void> {
  // Remove all .pb model files
  for (const model of MODELS) {
    const dest = path.join(MODELS_DIR, model.filename);
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch {}
  }
  // Also clean up legacy tfjs directory if it exists
  const tfjsDir = path.join(MODELS_DIR, 'tfjs');
  try {
    if (fs.existsSync(tfjsDir)) {
      fs.rmSync(tfjsDir, { recursive: true, force: true });
    }
  } catch {}
  await downloadModels();
}

export function isDownloadInProgress(): boolean {
  return isDownloading;
}
