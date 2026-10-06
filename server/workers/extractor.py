import sys
import os
import json
import subprocess
import time
# Keep each persistent worker bounded; the server controls process parallelism.
# Set before importing NumPy/Essentia, which initialize native thread pools.
threads = os.environ.get("AURORA_ANALYSIS_THREADS", "2")
if not threads.isdigit() or not 1 <= int(threads) <= 64:
    threads = "2"
for variable in ("TF_NUM_INTRAOP_THREADS", "TF_NUM_INTEROP_THREADS", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ[variable] = threads

import numpy as np
from essentia.standard import (
    TensorflowPredictMusiCNN,
    TensorflowPredictEffnetDiscogs,
    DynamicComplexity, RhythmExtractor2013, SpectralCentroidTime, Resample
)

ANALYSIS_DURATION_SECONDS = 15.0
ANALYSIS_SEEK_FRACTION = 0.35
MIN_AUDIO_SAMPLES = 4096
FFMPEG_TIMEOUT_SECONDS = 60
FEATURE_VERSION = 2
# Verified against msd-musicnn-1.json (MSD's 50 labels). Dance is a tag proxy.
MSD_TAGS = {"acoustic": 29, "instrumental": 23, "dance": 6}


def normalized_energy(audio):
    """RMS level mapped from -60 dBFS (0) to 0 dBFS (1), independent of length."""
    mean_square = float(np.mean(np.square(audio, dtype=np.float64)))
    if not np.isfinite(mean_square):
        raise ValueError("Non-finite audio energy")
    dbfs = 10.0 * np.log10(max(mean_square, 1e-6))
    return float(np.clip((dbfs + 60.0) / 60.0, 0.0, 1.0))


def prediction_mean(predictions, dimensions, label):
    values = np.asarray(predictions)
    if values.ndim != 2 or values.shape[0] == 0 or values.shape[1] != dimensions:
        raise ValueError(f"{label} returned invalid prediction shape: {values.shape}")
    if not np.all(np.isfinite(values)):
        raise ValueError(f"{label} returned non-finite predictions")
    return np.mean(values, axis=0, dtype=np.float64)


def prepare_model_audio(audio):
    # Both models need complete mel patches. Repeat very short clips instead of
    # averaging an empty prediction array; DSP still uses the original duration.
    minimum = 3 * 16000
    if len(audio) == 0 or not np.all(np.isfinite(audio)):
        raise ValueError("Invalid model audio")
    if len(audio) < minimum:
        return np.tile(audio, int(np.ceil(minimum / len(audio))))[:minimum]
    return audio

class PersistentExtractor:
    def __init__(self, musicnn_pb, effnet_pb):
        self.musicnn_pb = musicnn_pb
        self.effnet_pb = effnet_pb
        self.init_error = None
        self.effnet_model = None
        self.musicnn_model = None
        self.resampler = Resample(inputSampleRate=44100, outputSampleRate=16000, quality=1)
        self.rhythm = RhythmExtractor2013()
        self.complexity = DynamicComplexity()
        self.centroid = SpectralCentroidTime()
        self._init_models()

    def _init_models(self):
        started = time.perf_counter()
        try:
            self.effnet_model = TensorflowPredictEffnetDiscogs(
                graphFilename=self.effnet_pb,
                output="PartitionedCall:1",
                lastPatchMode="discard"
            )
            self.musicnn_model = TensorflowPredictMusiCNN(graphFilename=self.musicnn_pb, lastPatchMode="discard")
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            print(json.dumps({"event": "ready", "timings": {"model_init_ms": elapsed_ms}}), file=sys.stderr, flush=True)
        except Exception as e:
            self.init_error = str(e)
            print(json.dumps({"event": "init_error", "error": self.init_error}), file=sys.stderr, flush=True)

    def extract_features(self, file_path):
        if self.init_error:
            raise RuntimeError(f"Model initialization failed: {self.init_error}")
        if self.effnet_model is None or self.musicnn_model is None:
            raise RuntimeError("Model initialization failed")

        timings = {}
        total_started = time.perf_counter()

        def mark(stage, started):
            timings[f"{stage}_ms"] = round((time.perf_counter() - started) * 1000, 2)

        started = time.perf_counter()
        duration = probe_duration(file_path)
        start_time = choose_analysis_start(duration)
        timings["duration_probe_ms"] = round((time.perf_counter() - started) * 1000, 2)
        timings["source_duration_seconds"] = round(duration, 3) if duration is not None else None
        timings["analysis_start_seconds"] = round(start_time, 3)
        timings["analysis_duration_seconds"] = ANALYSIS_DURATION_SECONDS

        # Decode once at the DSP rate, then resample in memory for both models.
        started = time.perf_counter()
        audio_44k = decode_audio_window(file_path, 44100, start_time)
        mark("audio_44k_load", started)
        started = time.perf_counter()
        audio_16k = prepare_model_audio(self.resampler(audio_44k))
        mark("audio_16k_load", started)

        # 2. Discogs-EffNet (1280D Neural Embedding)
        started = time.perf_counter()
        embeddings = self.effnet_model(audio_16k)
        # Average frame-wise embeddings and L2 normalize for Cosine Distance
        mean_emb = prediction_mean(embeddings, 1280, "EffNet")
        norm = np.linalg.norm(mean_emb)
        if not np.isfinite(norm) or norm <= 0:
            raise ValueError("EffNet returned a zero or invalid embedding")
        effnet_vector = (mean_emb / norm).tolist()
        mark("effnet", started)

        # 3. MusiCNN (Classification Tags)
        started = time.perf_counter()
        tags = self.musicnn_model(audio_16k)
        mean_tags = prediction_mean(tags, 50, "MusiCNN")
        mark("musicnn", started)

        acousticness = float(mean_tags[MSD_TAGS["acoustic"]])
        instrumentalness = float(mean_tags[MSD_TAGS["instrumental"]])
        danceability = float(mean_tags[MSD_TAGS["dance"]])
        if np.any(mean_tags < 0) or np.any(mean_tags > 1):
            raise ValueError("MusiCNN returned probabilities outside [0, 1]")

        started = time.perf_counter()
        energy = normalized_energy(audio_44k)
        centroid = float(self.centroid(audio_44k))
        percussiveness = float(self.complexity(audio_44k)[0])
        # Tempo needs a longer observation than sub-second intros provide.
        # Report unknown (0) for clips shorter than the model's 3-second window.
        bpm = float(self.rhythm(audio_44k)[0]) if len(audio_44k) >= 3 * 44100 else 0.0
        if not all(np.isfinite(v) for v in (centroid, percussiveness, bpm)):
            raise ValueError("DSP returned non-finite features")
        mark("dsp", started)

        def scale(val, max_val):
            return max(0.0, min(1.0, val / max_val))

        acoustic_vector = [
            energy,                          # RMS level (normalized dBFS)
            scale(centroid, 10000),        # Brightness
            scale(percussiveness, 50),     # Percussiveness
            0.5,                             # Pitch Salience (Simplified)
            instrumentalness,                # Instrumentalness (ML)
            acousticness,                    # Acousticness (ML)
            danceability,                    # Danceability (ML)
            scale(bpm, 200)                # Tempo
        ]

        timings["total_ms"] = round((time.perf_counter() - total_started) * 1000, 2)

        return {
            "audioFeatures": {
                "bpm": round(bpm),
                "acoustic_vector": acoustic_vector,
                "embedding_vector": effnet_vector,
                "is_simulated": False,
                "feature_version": FEATURE_VERSION
            },
            "timings": timings
        }

def probe_duration(file_path):
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        value = float(proc.stdout.strip())
        return value if np.isfinite(value) and value > 0 else None
    except Exception:
        return None

def choose_analysis_start(duration):
    if duration is None or duration <= ANALYSIS_DURATION_SECONDS:
        return 0.0
    preferred = duration * ANALYSIS_SEEK_FRACTION
    latest = max(0.0, duration - ANALYSIS_DURATION_SECONDS)
    return min(preferred, latest)

def decode_audio_window(file_path, sample_rate, start_time):
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-loglevel", "error",
                "-ss", f"{start_time:.3f}",
                "-i", file_path,
                "-t", f"{ANALYSIS_DURATION_SECONDS:.3f}",
                "-f", "f32le",
                "-ac", "1",
                "-ar", str(sample_rate),
                "pipe:1",
            ],
            check=True,
            capture_output=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"ffmpeg segment decode timed out after {FFMPEG_TIMEOUT_SECONDS}s") from e
    except subprocess.CalledProcessError as e:
        message = e.stderr.decode("utf8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg segment decode failed: {message or e}") from e

    audio = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32, copy=True)
    if len(audio) < MIN_AUDIO_SAMPLES:
        raise RuntimeError(f"Decoded audio window too short: {len(audio)} samples")
    if not np.all(np.isfinite(audio)):
        raise RuntimeError("Decoded audio contains non-finite samples")
    return audio

def extract_features(file_path, musicnn_pb, effnet_pb):
    try:
        extractor = PersistentExtractor(musicnn_pb, effnet_pb)
        print(json.dumps(extractor.extract_features(file_path)["audioFeatures"], allow_nan=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

def worker_mode(musicnn_pb, effnet_pb):
    extractor = PersistentExtractor(musicnn_pb, effnet_pb)
    for line in sys.stdin:
        if not line.strip():
            continue
        job = {}
        try:
            job = json.loads(line)
            job_id = job.get("id")
            file_path = job.get("filePath")
            if not job_id or not file_path:
                raise ValueError("Job requires id and filePath")
            result = extractor.extract_features(file_path)
            print(json.dumps({
                "id": job_id,
                "audioFeatures": result["audioFeatures"],
                "timings": result["timings"]
            }, allow_nan=False), flush=True)
        except Exception as e:
            fallback_id = None
            try:
                fallback_id = job.get("id")
            except Exception:
                pass
            print(json.dumps({"id": fallback_id, "error": str(e)}), flush=True)

if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--worker":
        worker_mode(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 4:
        extract_features(sys.argv[1], sys.argv[2], sys.argv[3])
    else:
        print(json.dumps({"error": "Missing arguments"}), file=sys.stderr)
        sys.exit(1)
