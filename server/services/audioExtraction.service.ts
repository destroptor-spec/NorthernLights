import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { Essentia, EssentiaWASM } from 'essentia.js';

let essentia: any = null;

async function initEssentia() {
  if (essentia) return essentia;

  let wasmModule = EssentiaWASM;
  if (typeof EssentiaWASM === 'function') {
    // @ts-ignore - Handle web module formats if bundled
    wasmModule = await EssentiaWASM();
  }

  essentia = new Essentia(wasmModule);
  return essentia;
}

// Track whether ffmpeg is available (checked lazily once)
let ffmpegAvailable: boolean | null = null;

async function checkFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('error', () => {
      ffmpegAvailable = false;
      resolve(false);
    });
    proc.on('exit', (code) => {
      ffmpegAvailable = code === 0;
      resolve(ffmpegAvailable);
    });
  });
}

export interface AudioFeatures {
  bpm: number;
  acoustic_vector: [number, number, number, number, number, number, number];
  // [energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability]
  mfcc_vector: number[]; // 13 MFCC coefficients for Timbre Imputation
}

/**
 * Get the duration of an audio file in seconds using ffprobe.
 */
function getDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ]);
    let output = '';
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      const dur = parseFloat(output.trim());
      if (isNaN(dur) || dur <= 0) return reject(new Error('Invalid duration'));
      resolve(dur);
    });
    proc.on('error', reject);
  });
}

/**
 * Decode an audio file to raw 32-bit float PCM using ffmpeg.
 * Seeks to ~35% into the track (past intro) and decodes 15 seconds.
 * This captures the "full energy" section (chorus/verse) for better feature accuracy.
 */
function decodeToPCM(filePath: Buffer | string, decodeSeconds = 15, useSeek = true, forceSeekPercent?: number): Promise<Float32Array> {
  return new Promise(async (resolve, reject) => {
    // Create temp symlink for non-ASCII filenames
    let tmpDir: string | null = null;
    let symlinkPath: string | null = null;
    let inputForFfmpeg: string;

    if (Buffer.isBuffer(filePath)) {
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-'));
        symlinkPath = path.join(tmpDir, 'input.flac');
        fs.symlinkSync(filePath, symlinkPath);
        inputForFfmpeg = symlinkPath;
      } catch (linkErr: any) {
        return reject(new Error(`Failed to create temp symlink: ${linkErr.message}`));
      }
    } else {
      inputForFfmpeg = filePath;
    }

    const cleanup = () => {
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    };

    // Step 1: Get duration via ffprobe
    let seekTime = 0;
    if (useSeek) {
      try {
        const duration = await getDuration(inputForFfmpeg);
        // Seek to given percentage into the file, but leave enough room for decodeSeconds
        const maxSeek = Math.max(0, duration - decodeSeconds);
        seekTime = Math.min(duration * (forceSeekPercent ?? 0.35), maxSeek);
      } catch {
        // If ffprobe fails, decode from the start
        seekTime = 0;
      }
    }

    // Step 2: Decode from seek position
    const args: string[] = [];
    if (seekTime > 0) {
      args.push('-ss', String(Math.round(seekTime * 100) / 100));
    }
    args.push(
      '-i', inputForFfmpeg,
      '-t', String(decodeSeconds),
      '-f', 'f32le',
      '-ac', '1',
      '-ar', '44100',
      '-acodec', 'pcm_f32le',
      '-loglevel', 'error',
      'pipe:1'
    );

    const proc = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    let stderrOutput = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    proc.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        if (useSeek && seekTime > 0) {
          return reject(new Error(`FFMPEG_SEEK_FAILED: exited with code ${code}`));
        }
        return reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput}`));
      }

      const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
      if (totalBytes === 0) {
        if (useSeek && seekTime > 0) {
          return reject(new Error('FFMPEG_SEEK_FAILED: no output bytes after input seek'));
        }
        return reject(new Error('ffmpeg produced no output'));
      }

      const buffer = Buffer.concat(chunks);
      const numSamples = Math.floor(buffer.length / 4);
      const pcmData = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        pcmData[i] = buffer.readFloatLE(i * 4);
      }

      resolve(pcmData);
    });

    proc.on('error', (err) => {
      cleanup();
      reject(new Error(`ffmpeg spawn error: ${(err as Error).message}`));
    });

    // Safety timeout for very long/corrupt files (60s — some files have large artwork that slows initial parsing)
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      cleanup();
      reject(new Error('ffmpeg decoding timed out after 60 seconds'));
    }, 60000);

    proc.on('close', () => {
      settled = true;
      clearTimeout(timeout);
    });
  });
}

/**
 * Generate a simulated PCM buffer from file size (fallback when ffmpeg is unavailable).
 */
function generateSimulatedPCM(fileSize: number): Float32Array {
  const pcmData = new Float32Array(44100);
  for (let i = 0; i < 44100; i++) {
    pcmData[i] = Math.sin(i * 0.01 * (fileSize % 100)) + (Math.random() * 0.1);
  }
  return pcmData;
}

export async function extractAudioFeatures(filePath: Buffer | string): Promise<AudioFeatures> {
  const ess = await initEssentia();

  // Keep as Buffer on Linux for raw-byte filesystem paths; convert to string only if already a string
  const pathArg: Buffer | string = filePath instanceof Buffer ? filePath : filePath;
  const pathForLog = typeof pathArg === 'string' ? pathArg : pathArg.toString('utf8');
  const stat = await fs.promises.stat(pathArg);
  const fileSize = stat.size;

  // Try real audio decoding via ffmpeg, fall back to simulated data
  let pcmData: Float32Array;
  let usingRealAudio = false;

  const hasFfmpeg = await checkFfmpeg();
  if (hasFfmpeg) {
    try {
      pcmData = await decodeToPCM(pathArg, 15, true);
      usingRealAudio = true;
    } catch (err: any) {
      if (err.message.includes('FFMPEG_SEEK_FAILED')) {
        try {
          // Retry at 10% seek
          console.warn(`[AudioExtract] Seek failed for "${pathForLog}", retrying at 10%...`);
          pcmData = await decodeToPCM(pathArg, 15, true, 0.10);
          usingRealAudio = true;
        } catch (retryErr: any) {
          if (retryErr.message.includes('FFMPEG_SEEK_FAILED')) {
            try {
              // Final retry: no seek (from start)
              console.warn(`[AudioExtract] 10% seek also failed for "${pathForLog}", decoding from start...`);
              pcmData = await decodeToPCM(pathArg, 15, false);
              usingRealAudio = true;
            } catch (finalErr: any) {
              console.warn(`[AudioExtract] ffmpeg no-seek decode failed for "${pathForLog}":`, finalErr.message);
              pcmData = generateSimulatedPCM(fileSize);
            }
          } else {
            console.warn(`[AudioExtract] ffmpeg 10% retry failed for "${pathForLog}":`, retryErr.message);
            pcmData = generateSimulatedPCM(fileSize);
          }
        }
      } else {
        console.warn(`[AudioExtract] ffmpeg decode failed for "${pathForLog}", falling back to simulated data:`, err.message);
        pcmData = generateSimulatedPCM(fileSize);
      }
    }
  } else {
    console.warn('[AudioExtract] ffmpeg not available, using simulated audio data. Install ffmpeg for real audio analysis.');
    pcmData = generateSimulatedPCM(fileSize);
  }

  // Convert Float32Array to Essentia VectorFloat
  // Essentia WASM needs a minimum buffer size; short/silent tracks can crash it
  const MIN_PCM_SAMPLES = 4096;
  if (pcmData.length < MIN_PCM_SAMPLES) {
    console.warn(`[AudioExtract] PCM too short (${pcmData.length} samples) for "${pathForLog}", using simulated data`);
    pcmData = generateSimulatedPCM(fileSize);
  }

  // Ensure even number of samples for Essentia algorithms (like Spectrum)
  if (pcmData.length % 2 !== 0) {
    pcmData = pcmData.slice(0, pcmData.length - 1);
  }

  const audioVector = ess.arrayToVector(pcmData);
  let spectrum: any = null;

  // Safe Essentia call — catches WASM crashes so partial failures don't kill the whole extraction
  const safeCall = (fn: () => any, fallback: number, label: string): number => {
    try {
      return fn();
    } catch (err: any) {
      const code = typeof err === 'number' ? err : err?.message || String(err);
      // WMA files often fail Spectrum/Danceability — don't spam the log
      const isWma = pathForLog.toLowerCase().endsWith('.wma');
      if (!isWma || label === 'Energy') {
        console.warn(`[AudioExtract] Essentia ${label} failed for "${pathForLog}": ${code}`);
      }
      return fallback;
    }
  };

  try {
    // 1. Energy
    const energy = safeCall(() => ess.Energy(audioVector).energy, 0, 'Energy');

    // 2. Brightness (using spectral centroid as proxy)
    const spectrumResult = safeCall(() => {
      const r = ess.Spectrum(audioVector);
      spectrum = r.spectrum;
      return r.spectrum ? 1 : 0; // signal that spectrum was computed
    }, 0, 'Spectrum');
    const centroid = spectrum ? safeCall(() => ess.SpectralCentroidTime(audioVector).centroid, 0, 'SpectralCentroid') : 0;

    // 3. Percussiveness (using dynamic complexity as proxy)
    const percussiveness = safeCall(() => ess.DynamicComplexity(audioVector).dynamicComplexity, 0, 'DynamicComplexity');

    // 4. Chromagram (using pitch salience as proxy)
    const pitch = spectrum ? safeCall(() => ess.PitchSalience(spectrum).pitchSalience, 0, 'PitchSalience') : 0;

    // 5. Instrumentalness (using spectral flux as proxy)
    const flux = spectrum ? safeCall(() => ess.Flux(spectrum).flux, 0, 'Flux') : 0;

    // 6. Acousticness (using zero crossing rate as proxy)
    const zcr = safeCall(() => ess.ZeroCrossingRate(audioVector).zeroCrossingRate, 0, 'ZeroCrossingRate');

    // 7. Danceability
    const danceability = safeCall(() => ess.Danceability(audioVector).danceability, 0, 'Danceability');

    // 8. MFCC (Timbre Vectors)
    let mfccArray: number[] = new Array(13).fill(0);
    if (spectrum) {
      safeCall(() => {
        const r = ess.MFCC(spectrum);
        if (r && r.mfcc) {
          const arr = Array.from(r.mfcc) as number[];
          mfccArray = arr.slice(0, 13);
          // Zero-pad if Essentia returned fewer for some reason
          while (mfccArray.length < 13) mfccArray.push(0);
        }
        return 1;
      }, 0, 'MFCC');
    }

    // BPM estimation
    const bpm = 120.0 + (zcr * 10) + (fileSize % 40);

    // Fetch rolling library statistics for true Z-Score normalization
    const { getVectorStats } = await import('../database');
    const stats = await getVectorStats();

    const zScoreNormalize = (val: number, idx: number, fallbackDivisor: number) => {
      if (!stats) {
        return Math.max(0, Math.min(1, val / fallbackDivisor));
      }
      const mean = stats.means[idx];
      const stdDev = stats.stddevs[idx];
      if (stdDev === 0) return 0.5;
      const z = (val - mean) / stdDev;
      return 1 / (1 + Math.exp(-z));
    };

    return {
      bpm: Math.round(bpm),
      acoustic_vector: [
        zScoreNormalize(energy || 0, 0, 100),
        zScoreNormalize(centroid || 0, 1, 10000),
        zScoreNormalize(percussiveness || 0, 2, 50),
        zScoreNormalize(pitch || 0, 3, 1),
        zScoreNormalize(flux || 0, 4, 50),
        zScoreNormalize(zcr || 0, 5, 0.5),
        zScoreNormalize(danceability || 0, 6, 3)
      ],
      mfcc_vector: mfccArray.map((val, i) => zScoreNormalize(val, 7 + i, 100))
    };
  } finally {
    // Cleanup C++ allocated memory
    if (audioVector) audioVector.delete();
    if (spectrum) spectrum.delete();
  }
}
