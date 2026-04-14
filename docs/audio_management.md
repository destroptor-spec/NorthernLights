# Audio Management

## Playback Engine
- **HTML5 Audio**: Uses a single `HTMLAudioElement` wrapped by a `PlaybackManager` singleton.
- **Source Handling**: Audio is served via the `/api/stream?path=...` endpoint.
- **HTTP Streaming**: Implements partial content support (`Range` headers) on the Node.js server for efficient buffering and seeking of large lossless files (FLAC).

## Audio Analysis Pipeline

### Overview
The application extracts acoustic features from audio files to power the recommendation engine (Infinity Mode, Hub playlists). This is implemented as a **three-phase process**:

1. **Metadata Phase** (Library Scan): ID3/Vorbis tags extracted and stored in PostgreSQL.
2. **Analysis Phase** (Worker Threads): ffmpeg + Essentia WASM + Tensorflow extract high-dimensional feature vectors:
   - **8D Acoustic Semantic Vector** (rhythm/style)
   - **1280D Discogs-EffNet Embedding** (instrument/timbre)
3. **Feature Storage**: Results stored in `track_features` table with pgvector HNSW indexing across both vector spaces.

### Technical Implementation

#### ffmpeg Decoding
```
ffmpeg -ss <seek_to_35%> -i <input> -t 15 -f f32le -ac 1 -ar 44100 pipe:1
```
- **Smart Seeking**: Seeks to ~35% into track (past intro, into chorus/verse) for representative analysis
- **15-Second Window**: Captures enough audio for accurate feature extraction while minimizing memory
- **Raw PCM Output**: Float32 little-endian mono 44.1kHz for Essentia consumption

#### Essentia.js Analysis
WASM-based audio analysis running in **worker threads** to prevent blocking the main event loop:

**8D Acoustic Semantic Features** (in order):
1. **Energy** — Overall loudness/amplitude
2. **Brightness** (Spectral Centroid) — High-frequency content proxy
3. **Percussiveness** (Dynamic Complexity) — Rhythmic energy variation
4. **Chromagram** (Pitch Salience) — Harmonic content detection
5. **Instrumentalness** (Spectral Flux) — Texture complexity proxy
6. **Acousticness** (Zero Crossing Rate) — Timbre characteristics
7. **Danceability** — Essentia's danceability algorithm
8. **Tempo** — Normalized BPM (0.0 = 60 BPM, 0.5 = 120 BPM, 1.0 = 200+ BPM)

**1280D Discogs-EffNet Embeddings**:
The primary timbre/texture extraction model. It generates a 1280-dimensional embedding that captures deep acoustic signatures of instruments, production style, and recording quality. This replaces the legacy 13D MFCC system with a much higher fidelity representation.

**Safety Features:**
- Individual algorithm error handling — one failing algorithm doesn't kill the whole track
- Minimum buffer validation (4096 samples) before processing
- Per-file 90-second timeout to prevent hung files
- Graceful fallback to 0 for failed dimensions
- NaN/invalid vector guards on all vector operations

#### Worker Thread Architecture
```
Main Thread (Express Server)
  ├── Worker 1 → spawn("tsx analyzeTrack.ts") → stdin/stdout JSON
  ├── Worker 2 → spawn("tsx analyzeTrack.ts") → stdin/stdout JSON
  ├── Worker 3 → spawn("tsx analyzeTrack.ts") → stdin/stdout JSON
  └── Worker 4 → spawn("tsx analyzeTrack.ts") → stdin/stdout JSON
```

- **Concurrency Control**: `audioAnalysisCpu` setting (Background=1, Balanced=4, Maximum=6 workers)
- **Protocol**: Newline-delimited JSON over stdin/stdout
- **Process Lifetime**: Persistent child processes per worker, handling multiple tracks

#### Non-ASCII Filename Support
Node.js spawn always UTF-8 encodes arguments, mangling special characters. Workaround:
```typescript
// 1. Create temp symlink with ASCII-safe name
const tmpDir = fs.mkdtempSync('/tmp/am-XXXXXX');
const symlink = path.join(tmpDir, 'input.flac');
fs.symlinkSync(Buffer.from(rawBytes), symlink);

// 2. Pass symlink to ffmpeg (preserves raw bytes via Buffer API)
// 3. Clean up temp directory after processing
```

Handles: Danish `øæ`, em-dashes `–`, curly quotes `'` `"`, and other UTF-8 multi-byte sequences.

### Database Schema
```sql
CREATE TABLE track_features (
  track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE PRIMARY KEY,
  bpm NUMERIC,
  acoustic_vector_8d VECTOR(8),  -- 8D acoustic semantic
  embedding_vector VECTOR(1280)  -- 1280D Discogs-EffNet Timbre
);
CREATE INDEX track_features_idx ON track_features USING hnsw (acoustic_vector_8d vector_cosine_ops);
CREATE INDEX track_features_effnet_idx ON track_features USING hnsw (embedding_vector vector_cosine_ops);
```

### Normalization
Features are normalized using native SQL aggregation for ultra-fast library-wide computation:
```sql
SELECT AVG(acoustic_vector_8d), STDDEV(acoustic_vector_8d) FROM track_features
```
Z-score normalization per-dimension, then sigmoid to [0,1] range.

### Timbre-Weighted MFCC
For electronic/synthetic playlists (target acousticness < 0.3), MFCC timbre is weighted 3× in the SQL query to prioritize instrument texture over rhythm.

### SQL-Level Acousticness Dealbreaker
An asymmetric penalty applied in SQL: if the playlist targets EDM (acousticness < 0.2) but a track is fully acoustic (> 0.5), it receives a +5.0 distance spike at the query level.

## Audio Processing (Planned)
- **Web Audio API**: Will wrap the audio element with an `AudioContext` for advanced processing.
- **Chain**: `MediaElementAudioSourceNode` → `GainNode` (Volume) → `BiquadFilterNodes` (EQ) → `AnalyserNode` (Visualizer) → `destination`.
- **Cross-fade**: Orchestrated by dual gain-node ramps during track transitions.
- **Gapless**: Leveraging `audioContext.currentTime` and look-ahead buffering to schedule next track starts with micro-second precision.

## WMA Support
- **Transcoding**: WMA files are transcoded to MP3 on-the-fly via ffmpeg for browser compatibility
- **Format Detection**: File extension-based MIME type mapping in `MIME_TYPES` record
- **Seeking**: Currently limited (no Range request support for transcoded streams)
