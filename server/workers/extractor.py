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
    TensorflowPredictEffnetDiscogs,
    TensorflowPredict2D,
    DynamicComplexity, RhythmExtractor2013, SpectralCentroidTime, Resample
)

DSP_SAMPLE_RATE = 44100
MODEL_SAMPLE_RATE = 16000
ANALYSIS_DURATION_SECONDS = 15.0
# Three windows spread over the track. A blind listening A/B (2026-11-06) chose
# their mean over the old single window at 35 %; see
# docs/Aurora genre and style redesign.md, "Analysis window".
ANALYSIS_WINDOW_FRACTIONS = (0.20, 0.50, 0.80)
ANALYSIS_WINDOWS_LABEL = "3x15s@20/50/80%"
MIN_AUDIO_SAMPLES = 4096
FFMPEG_TIMEOUT_SECONDS = 60
FEATURE_VERSION = 3
STYLE_CLASSES = 400

# Every model runs on Discogs-EffNet: the backbone once per track, then small
# classifiers on its per-patch embeddings. Filenames and output indices are
# verified against each model's metadata JSON on essentia.upf.edu.
EFFNET_MODEL = "discogs-effnet-bs64-1.pb"
STYLE_MODEL = "genre_discogs400-discogs-effnet-1.pb"
# descriptor -> (model file, index of the class we report). Classes:
# danceability [danceable, not_danceable], mood_acoustic [acoustic, non_acoustic],
# voice_instrumental [instrumental, voice].
DESCRIPTOR_MODELS = {
    "danceability": ("danceability-discogs-effnet-1.pb", 0),
    "acousticness": ("mood_acoustic-discogs-effnet-1.pb", 0),
    "instrumentalness": ("voice_instrumental-discogs-effnet-1.pb", 0),
}


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
    minimum = 3 * MODEL_SAMPLE_RATE
    if len(audio) == 0 or not np.all(np.isfinite(audio)):
        raise ValueError("Invalid model audio")
    if len(audio) < minimum:
        return np.tile(audio, int(np.ceil(minimum / len(audio))))[:minimum]
    return audio


class ModelOutput:
    """Per-patch model outputs for one track."""

    def __init__(self, embeddings, styles, descriptors, timings):
        self.embeddings = embeddings    # [patches, 1280] Discogs-EffNet
        self.styles = styles            # [patches, 400] genre_discogs400 sigmoid scores
        self.descriptors = descriptors  # name -> [patches] probability of the reported class
        self.timings = timings


class EssentiaCpuBackend:
    """All neural inference lives here; decoding and DSP stay outside.

    A CUDA/ROCm backend only has to provide the same `infer` / `infer_many`
    contract: 16 kHz mono clips in, per-patch embeddings, style scores and
    descriptor probabilities out. Only the EffNet backbone is expensive; the
    classifiers on its embeddings take a few milliseconds. `infer_many` takes
    several tracks so a GPU backend can batch across tracks; this CPU backend
    runs them one after another.
    """

    name = "essentia-cpu"

    def __init__(self, models_dir):
        # The EffNet graph always runs fixed batches of 64 patches, so one call
        # over the concatenated windows costs the same as one call per window.
        self.effnet = TensorflowPredictEffnetDiscogs(
            graphFilename=os.path.join(models_dir, EFFNET_MODEL),
            output="PartitionedCall:1",
            lastPatchMode="discard"
        )
        # Matches EffNet's own PartitionedCall:0 output (max diff 1e-5 on 2,932
        # tracks) without a second backbone pass.
        self.style_head = TensorflowPredict2D(
            graphFilename=os.path.join(models_dir, STYLE_MODEL),
            input="serving_default_model_Placeholder",
            output="PartitionedCall:0"
        )
        self.descriptor_heads = {
            name: (TensorflowPredict2D(graphFilename=os.path.join(models_dir, filename),
                                       input="model/Placeholder", output="model/Softmax"), index)
            for name, (filename, index) in DESCRIPTOR_MODELS.items()
        }

    def infer(self, clips_16k):
        timings = {}
        audio = prepare_model_audio(np.concatenate(clips_16k))

        started = time.perf_counter()
        embeddings = np.asarray(self.effnet(audio))
        timings["effnet_ms"] = round((time.perf_counter() - started) * 1000, 2)

        started = time.perf_counter()
        styles = np.asarray(self.style_head(embeddings))
        descriptors = {name: np.asarray(head(embeddings))[:, index]
                       for name, (head, index) in self.descriptor_heads.items()}
        timings["heads_ms"] = round((time.perf_counter() - started) * 1000, 2)
        return ModelOutput(embeddings, styles, descriptors, timings)

    def infer_many(self, tracks_clips_16k):
        return [self.infer(clips) for clips in tracks_clips_16k]


class PersistentExtractor:
    def __init__(self, models_dir):
        self.init_error = None
        self.backend = None
        self.resampler = Resample(inputSampleRate=DSP_SAMPLE_RATE, outputSampleRate=MODEL_SAMPLE_RATE, quality=1)
        self.rhythm = RhythmExtractor2013()
        self.complexity = DynamicComplexity()
        self.centroid = SpectralCentroidTime()
        started = time.perf_counter()
        try:
            self.backend = EssentiaCpuBackend(models_dir)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            print(json.dumps({"event": "ready", "backend": self.backend.name, "timings": {"model_init_ms": elapsed_ms}}), file=sys.stderr, flush=True)
        except Exception as e:
            self.init_error = str(e)
            print(json.dumps({"event": "init_error", "error": self.init_error}), file=sys.stderr, flush=True)

    def extract_features(self, file_path, duration=None):
        if self.init_error:
            raise RuntimeError(f"Model initialization failed: {self.init_error}")
        if self.backend is None:
            raise RuntimeError("Model initialization failed")

        timings = {}
        total_started = time.perf_counter()

        def mark(stage, started):
            timings[f"{stage}_ms"] = round((time.perf_counter() - started) * 1000, 2)

        # The server sends the duration it already stored; probe only without it.
        if not (isinstance(duration, (int, float)) and np.isfinite(duration) and duration > 0):
            started = time.perf_counter()
            duration = probe_duration(file_path)
            mark("duration_probe", started)
        starts = choose_analysis_starts(duration)
        timings["source_duration_seconds"] = round(duration, 3) if duration is not None else None
        timings["analysis_starts_seconds"] = [round(s, 3) for s in starts]

        # One ffmpeg call decodes every window at both the DSP and the model rate.
        started = time.perf_counter()
        windows_44k, clips_16k = decode_audio_windows(file_path, starts)
        mark("decode", started)
        if clips_16k is None:  # single unpadded window: resample in memory
            started = time.perf_counter()
            clips_16k = [self.resampler(window) for window in windows_44k]
            mark("resample16", started)

        output = self.backend.infer(clips_16k)
        timings.update(output.timings)

        mean_emb = prediction_mean(output.embeddings, 1280, "EffNet")
        norm = np.linalg.norm(mean_emb)
        if not np.isfinite(norm) or norm <= 0:
            raise ValueError("EffNet returned a zero or invalid embedding")
        effnet_vector = (mean_emb / norm).tolist()

        style_scores = prediction_mean(output.styles, STYLE_CLASSES, "Style head")
        if np.any(style_scores < 0) or np.any(style_scores > 1):
            raise ValueError("Style head returned scores outside [0, 1]")
        descriptors = {}
        for name in DESCRIPTOR_MODELS:
            values = np.asarray(output.descriptors.get(name), dtype=np.float64).reshape(-1, 1)
            value = float(prediction_mean(values, 1, name)[0])
            if not 0 <= value <= 1:
                raise ValueError(f"{name} returned a probability outside [0, 1]")
            descriptors[name] = value
        acousticness = descriptors["acousticness"]
        instrumentalness = descriptors["instrumentalness"]
        danceability = descriptors["danceability"]

        started = time.perf_counter()
        energy = normalized_energy(np.concatenate(windows_44k))
        centroid = float(np.mean([self.centroid(window) for window in windows_44k]))
        percussiveness = float(np.mean([self.complexity(window)[0] for window in windows_44k]))
        # Tempo from the middle window only: a beat tracker run across window
        # joins would see false onsets. Sub-3 s clips report unknown (0).
        middle = windows_44k[len(windows_44k) // 2]
        bpm = float(self.rhythm(middle)[0]) if len(middle) >= 3 * DSP_SAMPLE_RATE else 0.0
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
            instrumentalness,                # Instrumentalness (EffNet classifier)
            acousticness,                    # Acousticness (EffNet classifier)
            danceability,                    # Danceability (EffNet classifier)
            scale(bpm, 200)                # Tempo
        ]

        timings["total_ms"] = round((time.perf_counter() - total_started) * 1000, 2)

        return {
            "audioFeatures": {
                "bpm": round(bpm),
                "acoustic_vector": acoustic_vector,
                "embedding_vector": effnet_vector,
                "style_scores": [round(float(v), 6) for v in style_scores],
                "analysis_windows": ANALYSIS_WINDOWS_LABEL if len(starts) > 1 else "1x15s@0%",
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

def choose_analysis_starts(duration):
    """Window start times. Tracks no longer than one window are analysed whole."""
    if duration is None or duration <= ANALYSIS_DURATION_SECONDS:
        return [0.0]
    latest = max(0.0, duration - ANALYSIS_DURATION_SECONDS)
    return [min(duration * fraction, latest) for fraction in ANALYSIS_WINDOW_FRACTIONS]

def _run_ffmpeg(args):
    try:
        proc = subprocess.run(args, check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"ffmpeg segment decode timed out after {FFMPEG_TIMEOUT_SECONDS}s") from e
    except subprocess.CalledProcessError as e:
        message = e.stderr.decode("utf8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg segment decode failed: {message or e}") from e
    audio = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32, copy=True)
    if not np.all(np.isfinite(audio)):
        raise RuntimeError("Decoded audio contains non-finite samples")
    return audio

def decode_audio_window(file_path, sample_rate, start_time):
    audio = _run_ffmpeg([
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
    ])
    if len(audio) < MIN_AUDIO_SAMPLES:
        raise RuntimeError(f"Decoded audio window too short: {len(audio)} samples")
    return audio

def decode_audio_windows(file_path, starts):
    """Decode every window with one ffmpeg process, at both sample rates.

    Returns (windows at 44.1 kHz for DSP, clips at 16 kHz for the models).
    Each input seeks on its own; the filter graph splits every window into a
    44.1 kHz and a 16 kHz branch, pads each to exactly one window length (only
    covers rounding at the file end, since starts are clamped to
    duration - window) and concatenates all branches into one raw stream that
    splits back by sample count. The 16 kHz branches are relabelled (asetrate)
    only so concat accepts them; their samples stay at 16 kHz. ffmpeg's
    resampler replaces a separate in-process resample (about 150 ms per track).

    A single window (tracks no longer than one window) is decoded unpadded at
    44.1 kHz and returns None for the clips, so the caller resamples it.
    """
    if len(starts) == 1:
        return [decode_audio_window(file_path, DSP_SAMPLE_RATE, starts[0])], None
    hi = int(round(ANALYSIS_DURATION_SECONDS * DSP_SAMPLE_RATE))
    lo = int(round(ANALYSIS_DURATION_SECONDS * MODEL_SAMPLE_RATE))
    n = len(starts)
    args = ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error"]
    for start in starts:
        args += ["-ss", f"{start:.3f}", "-t", f"{ANALYSIS_DURATION_SECONDS:.3f}", "-i", file_path]
    graph = ""
    for i in range(n):
        graph += (
            f"[{i}:a]aformat=sample_fmts=flt:channel_layouts=mono,asplit=2[s{i}h][s{i}l];"
            f"[s{i}h]aresample={DSP_SAMPLE_RATE},apad=whole_len={hi},atrim=end_sample={hi}[h{i}];"
            f"[s{i}l]aresample={MODEL_SAMPLE_RATE}:filter_size=64:phase_shift=10:cutoff=0.97,"
            f"apad=whole_len={lo},atrim=end_sample={lo},asetrate={DSP_SAMPLE_RATE}[l{i}];"
        )
    graph += "".join(f"[h{i}]" for i in range(n)) + "".join(f"[l{i}]" for i in range(n))
    graph += f"concat=n={2 * n}:v=0:a=1[out]"
    audio = _run_ffmpeg(args + ["-filter_complex", graph, "-map", "[out]", "-f", "f32le", "pipe:1"])
    expected = n * (hi + lo)
    if len(audio) != expected:
        raise RuntimeError(f"Decoded {len(audio)} samples, expected {expected}")
    windows_44k = [audio[i * hi:(i + 1) * hi] for i in range(n)]
    base = n * hi
    clips_16k = [audio[base + i * lo:base + (i + 1) * lo] for i in range(n)]
    return windows_44k, clips_16k

def extract_features(file_path, models_dir):
    try:
        extractor = PersistentExtractor(models_dir)
        print(json.dumps(extractor.extract_features(file_path)["audioFeatures"], allow_nan=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

def worker_mode(models_dir):
    extractor = PersistentExtractor(models_dir)
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
            result = extractor.extract_features(file_path, job.get("durationSeconds"))
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
    if len(sys.argv) >= 3 and sys.argv[1] == "--worker":
        worker_mode(sys.argv[2])
    elif len(sys.argv) >= 3:
        extract_features(sys.argv[1], sys.argv[2])
    else:
        print(json.dumps({"error": "Usage: extractor.py --worker <models_dir> | extractor.py <file> <models_dir>"}), file=sys.stderr)
        sys.exit(1)
