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
  acoustic_vector: [number, number, number, number, number, number, number, number];
  // [energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability, tempo]
  mfcc_vector: [number, number, number, number, number, number, number, number, number, number, number, number, number];
  // 13 Mel-Frequency Cepstral Coefficients providing timbre fingerprint
  is_simulated: boolean;
  // true when ffmpeg was unavailable and features were computed from synthetic PCM
}

/**
 * Get the duration of an audio file in seconds using ffprobe.
 */
function getDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',  // Only probe the first audio stream
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

    // Timeout for ffprobe — large artwork can stall initial parsing
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffprobe timed out after 15 seconds'));
    }, 15000);
    proc.on('close', () => clearTimeout(timer));
  });
}

/**
 * Decode an audio file to raw 32-bit float PCM using ffmpeg.
 * Seeks to ~35% into the track (past intro) and decodes 15 seconds.
 * This captures the "full energy" section (chorus/verse) for better feature accuracy.
 */
function decodeToPCM(filePath: Buffer | string, decodeSeconds = 15, useSeek = true): Promise<Float32Array> {
  return new Promise(async (resolve, reject) => {
    // Create temp symlink for non-ASCII filenames
    let tmpDir: string | null = null;
    let symlinkPath: string | null = null;
    let inputForFfmpeg: string;

    if (Buffer.isBuffer(filePath)) {
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-'));
        symlinkPath = path.join(tmpDir, 'input');
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
        // Seek to 35% into the file, but leave enough room for decodeSeconds
        const maxSeek = Math.max(0, duration - decodeSeconds);
        seekTime = Math.min(duration * 0.35, maxSeek);
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
      '-map', '0:a',  // Only map audio stream — skip embedded artwork/video
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
        // Code 183 = format detection failure — worth retrying without seek
        if (code === 183) {
          return reject(new Error(`FFMPEG_SEEK_FAILED: exited with code ${code} (format detection)`));
        }
        return reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput}`));
      }

      const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
      if (totalBytes === 0) {
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

export interface VectorStats {
  means: number[];
  stddevs: number[];
}

export async function extractAudioFeatures(filePath: Buffer | string, vectorStats?: VectorStats | null): Promise<AudioFeatures> {
  const ess = await initEssentia();

  const pathForLog = typeof filePath === 'string' ? filePath : filePath.toString('utf8');
  console.log(`[AudioExtract] Starting analysis for: ${pathForLog}`);
  const startTime = Date.now();
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;

  // Try real audio decoding via ffmpeg, fall back to simulated data
  let pcmData: Float32Array;
  let usingRealAudio = false;

  const hasFfmpeg = await checkFfmpeg();
  if (hasFfmpeg) {
    try {
      pcmData = await decodeToPCM(filePath, 15, true);
      usingRealAudio = true;
    } catch (err: any) {
      if (err.message.includes('FFMPEG_SEEK_FAILED')) {
        try {
          console.warn(`[AudioExtract] Seek failed for "${pathForLog}", retrying from the start...`);
          pcmData = await decodeToPCM(filePath, 15, false);
          usingRealAudio = true;
        } catch (retryErr: any) {
          console.warn(`[AudioExtract] ffmpeg retry decode failed for "${pathForLog}":`, retryErr.message);
          pcmData = generateSimulatedPCM(fileSize);
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

    // BPM estimation using RhythmExtractor2013
    let bpm = 120;
    try {
      const rhythmResult = ess.RhythmExtractor2013(audioVector);
      bpm = Math.round(rhythmResult.bpm ?? 120);
      if (rhythmResult) {
        try { rhythmResult.delete(); } catch {}
      }
    } catch (err) {
      console.warn(`[AudioExtract] RhythmExtractor2013 failed:`, err);
    }

    // ── MFCC Timbre Extraction — Option C: frame-averaged (13 coefficients) ─
    // Split the 15s PCM into overlapping 2048-sample Hanning-windowed frames
    // (50% hop ≈ 644 frames). Compute Spectrum + MFCC per frame, accumulate,
    // average across all valid frames, then sigmoid-normalize to [0,1].
    // This gives a stable timbre fingerprint vs a single full-buffer snapshot.
    const FRAME_SIZE = 2048;
    const HOP_SIZE = 1024;
    const NUM_MFCC = 13;
    const sigmoid = (x: number, scale: number) => 1 / (1 + Math.exp(-x / scale));

    // Pre-compute Hanning window coefficients once (avoids 644×2048 = 1.3M cos() calls)
    const hanningWindow = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      hanningWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1)));
    }

    const mfccAccum = new Array(NUM_MFCC).fill(0);
    let validFrames = 0;
    const numFrames = Math.max(0, Math.floor((pcmData.length - FRAME_SIZE) / HOP_SIZE) + 1);

    // Reuse a single buffer for windowed frame data
    const windowed = new Float32Array(FRAME_SIZE);

    for (let fi = 0; fi < numFrames; fi++) {
      const start = fi * HOP_SIZE;
      // Apply pre-computed Hanning window
      for (let i = 0; i < FRAME_SIZE; i++) {
        windowed[i] = (pcmData[start + i] ?? 0) * hanningWindow[i];
      }

      let frameVec: any = null;
      let frameSpec: any = null;
      try {
        frameVec = ess.arrayToVector(windowed);
        const specResult = ess.Spectrum(frameVec);
        frameSpec = specResult.spectrum;

        const mfccResult = ess.MFCC(frameSpec);
        if (mfccResult?.mfcc) {
          for (let k = 0; k < NUM_MFCC; k++) {
            mfccAccum[k] += mfccResult.mfcc.get(k);
          }
          validFrames++;
          try { mfccResult.mfcc.delete(); } catch {}
          try { mfccResult.bands?.delete(); } catch {}
        }
      } catch {
        // skip bad frames silently
      } finally {
        try { frameSpec?.delete(); } catch {}
        try { frameVec?.delete(); } catch {}
      }
    }

    // Average raw values across frames then sigmoid-normalize.
    // MFCC[0] (log energy) sits ~30–60; coefficients 1-12 oscillate ~±20.
    const mfcc_vector = mfccAccum.map((sum, k) => {
      const avg = validFrames > 0 ? sum / validFrames : 0;
      return sigmoid(avg, k === 0 ? 20 : 8);
    }) as AudioFeatures['mfcc_vector'];

    // Use pre-fetched stats if provided; on first-ever scan (no existing features), stats will be null
    // and we fall through to the simple divisor normalization below.
    const stats = vectorStats ?? null;

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
          zScoreNormalize(danceability || 0, 6, 3),
          zScoreNormalize(bpm, 7, 200)
        ],
        mfcc_vector,
        is_simulated: !usingRealAudio
      };
    } finally {
      const elapsed = Date.now() - startTime;
      console.log(`[AudioExtract] Completed analysis for: ${pathForLog} in ${elapsed}ms`);
      // Cleanup C++ allocated memory (frame-level vectors are deleted inside the loop)
      if (audioVector) audioVector.delete();
      if (spectrum) spectrum.delete();
    }
  }
