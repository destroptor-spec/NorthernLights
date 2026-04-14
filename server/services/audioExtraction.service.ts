import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MODELS_DIR } from './downloadModels';

const execFileAsync = promisify(execFile);

export interface AudioFeatures {
  bpm: number;
  acoustic_vector: number[];
  embedding_vector: number[];
  is_simulated: boolean;
}

export async function extractAudioFeatures(filePath: string): Promise<AudioFeatures> {
  const musicnnPb = path.join(MODELS_DIR, 'msd-musicnn-1.pb');
  const effnetPb = path.join(MODELS_DIR, 'discogs-effnet-bs64-1.pb');
  const extractorScript = path.join(__dirname, '..', 'workers', 'extractor.py');

  // Use the local virtual environment's Python if it exists, otherwise fallback to system python3
  const venvPythonPath = path.join(__dirname, '..', '..', '.venv', 'bin', 'python3');
  const pythonExecutable = require('fs').existsSync(venvPythonPath) ? venvPythonPath : 'python3';

  try {
    const { stdout } = await execFileAsync(pythonExecutable, [
      extractorScript, 
      filePath, 
      musicnnPb, 
      effnetPb
    ], {
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer for the JSON output
    });

    const features = JSON.parse(stdout.trim());
    if (features.error) {
      throw new Error(`Python Error: ${features.error}`);
    }

    return features as AudioFeatures;
  } catch (error: any) {
    console.error(`[AudioExtract] Failed for ${filePath}:`, error.message);
    
    // Graceful degradation: If Python fails, return a simulated vector
    return {
      bpm: 120,
      acoustic_vector: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      embedding_vector: new Array(1280).fill(0),
      is_simulated: true
    };
  }
}
