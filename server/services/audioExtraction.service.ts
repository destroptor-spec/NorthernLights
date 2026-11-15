import { workerLog } from '../workers/workerLog';
import fs from 'fs';
import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { MODELS_DIR } from './downloadModels';
import { AUDIO_FEATURE_VERSION, STYLE_SCORE_COUNT } from './audioFeatureVersion';
import { AUDIO_MOODS, MOOD_THEMES, type AudioMood } from '../../shared/audioMoods';

/**
 * Essentia prints "No network created, or last created network has been
 * deleted" each time a model or rhythm extractor is torn down: harmless, and
 * several lines per track. It made up most of prod's 1.6 GB error log during
 * analysis, so it is dropped before logging.
 */
const HARMLESS_PYTHON_LINE = /No network created, or last created network has been deleted/;

export function dropHarmlessPythonLines(chunk: string): string {
  return chunk.split('\n').filter(line => line.trim() && !HARMLESS_PYTHON_LINE.test(line)).join('\n');
}

export interface AudioFeatures {
  bpm: number;
  acoustic_vector: number[];
  embedding_vector: number[];
  /** genre_discogs400 sigmoid scores in model order; null for simulated features. */
  style_scores: number[] | null;
  /** Which audio the scores and vectors came from, e.g. '3x15s@20/50/80%'. */
  analysis_windows?: string;
  /** Moods from the sound (0–1); null when the mood models aren't installed. */
  moods?: Record<AudioMood, number> | null;
  /** MTG-Jamendo mood/theme scores in MOOD_THEMES order; null without the model. */
  mood_themes?: number[] | null;
  is_simulated: boolean;
  feature_version: number;
  /** The real length in seconds, when the stored one proved wrong and the extractor measured it. */
  measured_duration?: number | null;
}

export interface AudioExtractionContext {
  trackId?: string;
  title?: string | null;
  artist?: string | null;
  /** Stored track duration; lets the extractor skip its own ffprobe call. */
  durationSeconds?: number | null;
}

export interface MoodScores {
  moods: Record<AudioMood, number>;
  mood_themes: number[] | null;
}

interface PythonWorkerResult {
  id: string;
  audioFeatures?: AudioFeatures;
  moodScores?: MoodScores[];
  error?: string;
  timings?: Record<string, unknown>;
}

class PersistentPythonAnalyzer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, {
    resolve: (result: PythonWorkerResult) => void;
    reject: (error: Error) => void;
  }>();

  private get pythonExecutable(): string {
    const venvPythonPath = path.join(__dirname, '..', '..', '.venv', 'bin', 'python3');
    return fs.existsSync(venvPythonPath) ? venvPythonPath : 'python3';
  }

  private get extractorScript(): string {
    return path.join(__dirname, '..', 'workers', 'extractor.py');
  }

  private ensureStarted() {
    if (this.child && !this.child.killed && this.child.stdin.writable) {
      return;
    }

    let stdoutBuffer = '';
    const child = this.child = spawn(this.pythonExecutable, [
      this.extractorScript,
      '--worker',
      // extractor.py resolves its model files (EffNet + classifiers) here.
      MODELS_DIR,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const result = JSON.parse(line) as PythonWorkerResult;
          const pending = result.id ? this.pending.get(result.id) : undefined;
          if (!pending) continue;
          this.pending.delete(result.id);
          pending.resolve(result);
        } catch (error: any) {
          workerLog('warn', `[AudioExtract] Ignored malformed Python analyzer output: ${error?.message || error}`);
        }
      }
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-8192);
      const useful = dropHarmlessPythonLines(chunk);
      if (useful) workerLog('debug', `[AudioExtract:python] ${useful}`);
    });

    const rejectPending = (message: string) => {
      const pendingJobs = Array.from(this.pending.values());
      this.pending.clear();
      for (const pending of pendingJobs) {
        pending.reject(new Error(message));
      }
    };

    const fail = (message: string) => {
      if (this.child !== child) return;
      this.child = null;
      rejectPending(message);
      child.kill('SIGKILL');
    };
    child.stdin.on('error', error => fail(`Python analyzer input failed: ${error.message}`));
    child.on('error', error => fail(`Python analyzer failed: ${error.message}`));
    child.on('exit', (code, signal) => fail(`Python analyzer exited (code=${code}, signal=${signal})${stderrTail ? `: ${stderrTail}` : ''}`));

  }

  /** Moods for stored embeddings (unit-length per-track means), in the same worker. */
  scoreEmbeddings(embeddings: number[][]): Promise<PythonWorkerResult> {
    this.ensureStarted();
    const child = this.child;
    if (!child) return Promise.reject(new Error('Python analyzer failed to start'));
    const id = `moods:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, embeddings }) + '\n', (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  run(filePath: string, context?: AudioExtractionContext): Promise<PythonWorkerResult> {
    this.ensureStarted();
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error('Python analyzer failed to start'));
    }

    const id = `${context?.trackId || path.basename(filePath)}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const duration = context?.durationSeconds;
      const job = Number.isFinite(duration) && (duration as number) > 0
        ? { id, filePath, durationSeconds: duration }
        : { id, filePath };
      child.stdin.write(JSON.stringify(job) + '\n', (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  shutdown() {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGKILL');
    }
  }
}

const analyzer = new PersistentPythonAnalyzer();

function buildSimulatedFeatures(): AudioFeatures {
  return {
    bpm: 120,
    acoustic_vector: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    embedding_vector: new Array(1280).fill(0),
    style_scores: null,
    is_simulated: true,
    feature_version: AUDIO_FEATURE_VERSION
  };
}

function logTimings(context: AudioExtractionContext | undefined, timings: Record<string, unknown> | undefined) {
  if (!timings) return;
  const label = context?.trackId || context?.title || 'unknown';
  const parts = [
    `total=${timings.total_ms ?? 'n/a'}ms`,
    `decode=${timings.decode_ms ?? 'n/a'}ms`,
    `probe=${timings.duration_probe_ms ?? 'skipped'}`,
    `resample16=${timings.resample16_ms ?? 'ffmpeg'}`,
    `effnet=${timings.effnet_ms ?? 'n/a'}ms`,
    `heads=${timings.heads_ms ?? 'n/a'}ms`,
    `dsp=${timings.dsp_ms ?? 'n/a'}ms`,
  ];
  workerLog('debug', `[AudioExtract] Timing track=${label} ${parts.join(' ')}`);
}

function logSimulatedFallback(filePath: string, context: AudioExtractionContext | undefined, reason: string) {
  const details = {
    trackId: context?.trackId || null,
    title: context?.title || null,
    artist: context?.artist || null,
    filePath,
    reason,
  };
  workerLog('error', `[AudioExtract] Simulated fallback ${JSON.stringify(details)}`);
}

export async function extractAudioFeatures(filePath: string, context?: AudioExtractionContext): Promise<AudioFeatures> {
  try {
    const result = await analyzer.run(filePath, context);
    logTimings(context, result.timings);

    if (result.error) {
      throw new Error(`Python Error: ${result.error}`);
    }
    if (!result.audioFeatures) {
      throw new Error('Python analyzer returned no audio features');
    }

    const features = result.audioFeatures;
    if (features.feature_version !== AUDIO_FEATURE_VERSION || features.is_simulated !== false
      || !Number.isFinite(features.bpm) || features.bpm < 0
      || !Array.isArray(features.acoustic_vector) || features.acoustic_vector.length !== 8
      || features.acoustic_vector.some(value => !Number.isFinite(value) || value < 0 || value > 1)
      || !Array.isArray(features.embedding_vector) || features.embedding_vector.length !== 1280
      || features.embedding_vector.some(value => !Number.isFinite(value))
      || !features.embedding_vector.some(value => value !== 0)
      || !Array.isArray(features.style_scores) || features.style_scores.length !== STYLE_SCORE_COUNT
      || features.style_scores.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('Python analyzer returned invalid audio features');
    }
    if (features.measured_duration != null
      && !(typeof features.measured_duration === 'number' && Number.isFinite(features.measured_duration) && features.measured_duration > 0)) {
      features.measured_duration = null;
    }
    // Moods are optional: invalid ones are dropped, never the analysis.
    if (!validMoodScores({ moods: features.moods as any, mood_themes: features.mood_themes ?? null })) {
      features.moods = null;
      features.mood_themes = null;
    }
    return features;
  } catch (error: any) {
    const reason = error?.message || String(error);
    logSimulatedFallback(filePath, context, reason);

    return buildSimulatedFeatures();
  }
}

function validMoodScores(scores: Partial<MoodScores> | null | undefined): scores is MoodScores {
  if (!scores?.moods) return false;
  const inRange = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!AUDIO_MOODS.every(mood => inRange(scores.moods![mood]))) return false;
  return scores.mood_themes == null
    || (Array.isArray(scores.mood_themes) && scores.mood_themes.length === MOOD_THEMES.length && scores.mood_themes.every(inRange));
}

/**
 * Moods for stored embeddings (unit-length per-track means): the backfill
 * for tracks analysed before mood scores. Rejects when the mood models are
 * missing or the worker fails.
 */
export async function scoreMoodsFromEmbeddings(embeddings: number[][]): Promise<MoodScores[]> {
  const result = await analyzer.scoreEmbeddings(embeddings);
  if (result.error) throw new Error(result.error);
  const scores = result.moodScores;
  if (!Array.isArray(scores) || scores.length !== embeddings.length || !scores.every(validMoodScores)) {
    throw new Error('Python analyzer returned invalid mood scores');
  }
  return scores;
}

process.once('exit', () => {
  analyzer.shutdown();
});
