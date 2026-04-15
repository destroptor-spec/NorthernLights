# Audio Management

## Playback Engine
- **HTML5 Audio + hls.js**: Uses a single `HTMLAudioElement` wrapped by a `PlaybackManager` singleton. Audio is delivered via HLS (HTTP Live Streaming) using `hls.js` on desktop browsers and native HLS on iOS Safari.
- **Source Handling**: Audio is served via the `/api/stream/:trackId/playlist.m3u8?quality=<quality>` endpoint. Individual `.ts` transport stream segments are served from `/api/stream/:trackId/<segment>.ts`.
- **Seeking**: HLS segments are individually addressable — scrubbing/seeking loads only the relevant chunk without re-downloading the entire stream.
- **AudioContext**: Initialized on the very first user interaction (click/touch in `App.tsx`) to comply with Safari's autoplay policy. The `PlaybackManager.ensureAudioContext()` method creates the context in a suspended state and connects the `MediaElementAudioSourceNode`.

## HLS Streaming Architecture

### Overview
Audio files are sliced into 10-second HLS chunks on-the-fly by FFmpeg on the backend. The frontend consumes these via `hls.js` (or native HLS on iOS Safari). The Service Worker caches individual `.ts` chunks for offline playback.

### Backend: On-the-Fly HLS Generation

**Service**: `server/services/hlsStream.service.ts`
**Route**: `server/routes/media.routes.ts`

```
Client Request → /api/stream/:trackId/playlist.m3u8?quality=128k
                    ↓
          Track lookup from PostgreSQL (path, bitrate)
                    ↓
          Security check (isPathAllowed)
                    ↓
          getOrCreateHlsSession()
                    ↓
          FFmpeg spawns → writes to os.tmpdir()/nl-hls-streams/<trackId>-<quality>/
                    ↓
          Serves playlist.m3u8 once first segment is ready
```

### The Source Rule (Remux vs Transcode)

The backend evaluates the requested quality against the source file's bitrate (stored in the `tracks.bitrate` column during library scan):

| Condition | Action | FFmpeg Flag |
|-----------|--------|-------------|
| `quality === 'source'` | **Remux** — change container only | `-c:a copy` |
| `requestedBitrate >= sourceBitrate` | **Remux** — no upsampling | `-c:a copy` |
| `requestedBitrate < sourceBitrate` | **Transcode** to AAC | `-c:a aac -b:a <quality>` |

Remuxing uses zero CPU and preserves original quality.

### Quality Tiers

| Setting | Bitrate | Description |
|---------|---------|-------------|
| `auto` | 128 kbps | Default — always uses Normal quality |
| `64k` | 64 kbps | Low quality, saves bandwidth |
| `128k` | 128 kbps | Normal — good balance |
| `160k` | 160 kbps | High quality |
| `320k` | 320 kbps | Very High — near-lossless |
| `source` | Original | No conversion, direct file remux |

Quality is persisted in the Zustand store (`streamingQuality`) and applied when building track URLs.

### Session Lifecycle

- Sessions are keyed by `trackId::quality`
- Reused if an identical session exists (no duplicate FFmpeg processes)
- Auto-reaped after 30 minutes of inactivity
- All sessions cleaned up on server shutdown (SIGINT/SIGTERM)
- Output directory: `os.tmpdir()/nl-hls-streams/`

### FFmpeg Command

```bash
ffmpeg -i <input> -vn -map 0:a:0 \
  [-c:a copy | -c:a aac -b:a 128k] \
  -hls_time 10 -hls_list_size 0 \
  -hls_segment_filename <dir>/segment%03d.ts \
  -hls_flags independent_segments \
  -f hls <dir>/playlist.m3u8
```

### Frontend: hls.js Integration

**File**: `src/utils/PlaybackManager.ts`

- `playUrl()` detects `.m3u8` URLs and routes to `playHls()`
- `playHls()` creates an `Hls` instance with `maxBufferLength: 60` (buffers 60s ahead)
- Waits for `MANIFEST_PARSED` event before calling `safePlay()`
- iOS Safari fallback: uses native `<audio>` element with HLS src directly
- `safePlay()` handles `NotAllowedError` (autoplay blocked) gracefully

### Client-Side Caching (Service Worker)

Configured via Workbox in `vite.config.ts`:

| Pattern | Strategy | Cache Name | TTL |
|---------|----------|------------|-----|
| `*.ts` segments | CacheFirst | `nl-audio-chunks-v1` | 7 days, 2000 entries |
| `*.m3u8` playlists | NetworkFirst | `nl-audio-playlists-v1` | 1 day, 200 entries |
| `/api/art` | CacheFirst | `media-cache` | 30 days, 500 entries |

Segments are immutable (cache-forever safe). Playlists use NetworkFirst so they're always fresh, with cache fallback for offline.

## Audio Analysis Pipeline

### Overview
The application extracts acoustic features from audio files to power the recommendation engine (Infinity Mode, Hub playlists). This is implemented as a **three-phase process**:

1. **Metadata Phase** (Library Scan): ID3/Vorbis/ASF tags extracted and stored in PostgreSQL.
2. **Analysis Phase** (Worker Threads): ffmpeg + Python + TensorFlow extract high-dimensional feature vectors:
   - **8D/10D Acoustic Vector** (Rhythm, style, and instrumentation)
   - **1280D Discogs-EffNet Embedding** (Neural timbre and production fingerprint)
3. **Feature Storage**: Results stored in `track_features` table with pgvector HNSW indexing for ultra-fast similarity search.

### Technical Implementation

#### ffmpeg Decoding
```
ffmpeg -ss <seek_to_35%> -i <input> -t 15 -f f32le -ac 1 -ar 44100 pipe:1
```
- **Smart Seeking**: Seeks to ~35% into the track (past intros/silence) to capture a representative segment of the chorus or main verse.
- **15-Second Window**: Captures sufficient audio for the ML models to generate stable embeddings while minimizing memory and CPU overhead.
- **Raw PCM Output**: Decodes to 16-bit little-endian mono PCM at 44.1kHz for the analysis engine.

#### Python ML Engine
The analysis has transitioned from WASM-based processing to a dedicated **Python 3** engine using the **Essentia Python library** and **TensorFlow** models.

**MusiCNN (8D/10D Acoustic Features)**:
Extracted using the MusiCNN classification model and traditional DSP algorithms:
1. **Energy** — Overall amplitude and loudness.
2. **Brightness** (Spectral Centroid) — Frequency balance (high-frequency content proxy).
3. **Percussiveness** (Dynamic Complexity) — Rhythmic energy variation.
4. **Pitch Salience** — Harmonic clarity/tonality.
5. **Instrumentalness** (ML-derived) — Probability that the track is instrumental.
6. **Acousticness** (ML-derived) — Probability of acoustic vs. synthetic instruments.
7. **Danceability** (ML-derived) — Rhythmic stability and "grid" adherence.
8. **Tempo** — Normalized BPM estimation.

**Discogs-EffNet (1280D Neural Embedding)**:
The primary system for timbre and production similarity. It uses a **EfficientNet-based model** (Discogs-EffNet) to generate a high-fidelity **1280-dimensional** embedding.
- **Neural Timbre**: Captures the "texture" of the audio (e.g., tube saturation, reverb style, specific synthesizer characteristics).
- **L2 Normalization**: Embeddings are L2-normalized at extraction time to allow for **Cosine Similarity** search in PostgreSQL.

#### Worker Thread Architecture
```
Main Thread (Express Server)
  ├── Worker 1 → spawn("tsx analyzeTrack.ts")
  │     └── child_process → extractor.py (Python ML)
  ├── Worker 2 → spawn("tsx analyzeTrack.ts")
  │     └── child_process → extractor.py (Python ML)
  ...
```
- **Process Isolation**: Node.js manages a pool of `analyzeTrack.ts` workers. Each worker spawns the Python `extractor.py` script for each file.
- **Resource Management**: Concurrency is adjusted via the "Audio Analysis Workers" setting in the UI.
SON
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
- **Web Audio API**: The audio element is wrapped with an `AudioContext` (initialized on first user interaction). Currently routes `MediaElementAudioSourceNode` → `destination`.
- **Future Chain**: `MediaElementAudioSourceNode` → `GainNode` (Volume) → `BiquadFilterNodes` (EQ) → `AnalyserNode` (Visualizer) → `destination`.
- **Cross-fade**: Orchestrated by dual gain-node ramps during track transitions.
- **Gapless**: Leveraging `audioContext.currentTime` and look-ahead buffering to schedule next track starts with micro-second precision.

## WMA Support
- **Transcoding**: WMA files are transcoded to AAC on-the-fly via the HLS pipeline (same as other formats when quality < source bitrate)
- **Legacy fallback**: Direct WMA → MP3 pipe streaming is preserved in the `/api/stream` legacy endpoint
- **Format Detection**: File extension-based MIME type mapping in `MIME_TYPES` record

