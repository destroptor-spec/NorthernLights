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

**Services**: `server/services/hlsStream.service.ts` (fixed presets) and `server/services/adaptiveHlsStream.service.ts` (Auto)
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

For `quality=auto`, the master playlist is source-aware and contains an AAC ladder selected from 64/128/160/320 kbps. Known lossy sources are capped at their stored source bitrate. Lossless sources and sources without reliable bitrate metadata may use the full 320 kbps ceiling. Browser Data Saver requests `maxBitrate=64k`, producing a one-rendition Auto master.

Adaptive media packaging decodes the input once. One FFmpeg process uses `asplit` plus `var_stream_map` to encode every rendition and write aligned 10-second MPEG-TS playlists under one session directory:

```text
os.tmpdir()/nl-adaptive-hls-streams/<session-hash>/
  64k/playlist.m3u8 + segmentNNN.ts
  128k/playlist.m3u8 + segmentNNN.ts
  160k/playlist.m3u8 + segmentNNN.ts
  320k/playlist.m3u8 + segmentNNN.ts
```

The service does not mark the package ready until every rendition playlist has at least two segments (or a complete one-segment short track). Sessions deduplicate by exact track, ladder, and codec. A failed zero-segment process is discarded so the next request can create a fresh session.

### The Source Rule (Remux vs Transcode)

The backend evaluates the requested quality against the source file's bitrate (stored in the `tracks.bitrate` column during library scan):

| Condition | Action | FFmpeg Flag |
|-----------|--------|-------------|
| Browser `source`, natively playable codec | Stream original bytes with Range support | HLS bypassed |
| HLS `source`, TS-compatible codec matches target | **Remux**, change container only | `-c:a copy` |
| Fixed preset at/above source bitrate, codec matches target | **Remux**, no upsampling | `-c:a copy` |
| Incompatible codec/container or lower fixed preset | **Transcode** to AAC | `-c:a aac -b:a <quality>` |

Remuxing uses negligible CPU and preserves original quality. `source` never becomes a literal FFmpeg bitrate; incompatible HLS sources use a real bounded transcode bitrate instead.

### Quality Tiers

| Setting | Bitrate | Description |
|---------|---------|-------------|
| `auto` | Adaptive 64–320 kbps AAC | Browser hls.js/native HLS selects from a source-aware ladder |
| `64k` | 64 kbps | Low quality, saves bandwidth |
| `128k` | 128 kbps | Normal — good balance |
| `160k` | 160 kbps | High quality |
| `320k` | 320 kbps | Very High — near-lossless |
| `source` | Original | No conversion, direct file remux |

Quality is persisted in the Zustand store (`streamingQuality`) and applied when building track URLs.

`auto` is preserved in hydrated library, playlist, continuity, prepared-track, and runtime playback URLs. Chromecast has a separate resolver: both `auto` and `source` become fixed 128 kbps AAC for the current custom receiver path.

### Session Lifecycle

- Fixed sessions are keyed by `trackId::quality::codec`
- Adaptive sessions are keyed by `trackId::ladder::codec`
- Reused if an identical session exists (no duplicate FFmpeg processes)
- Auto-reaped after 30 minutes of inactivity
- All sessions cleaned up on server shutdown (SIGINT/SIGTERM)
- Output directory: `os.tmpdir()/nl-hls-streams/`
- Adaptive output directory: `os.tmpdir()/nl-adaptive-hls-streams/`

### FFmpeg Command

```bash
ffmpeg -i <input> -vn -map 0:a:0 \
  [-c:a copy | -c:a aac -b:a 128k] \
  -hls_time 10 -hls_list_size 0 \
  -hls_segment_filename <dir>/segment%03d.ts \
  -hls_flags independent_segments \
  -f hls <dir>/playlist.m3u8
```

Adaptive Auto uses one input and one process:

```bash
ffmpeg -i <input> -vn \
  -filter_complex '[0:a:0]asplit=4[a0][a1][a2][a3]' \
  -map '[a0]' -c:a:0 aac -b:a:0 64k -profile:a:0 aac_low \
  -map '[a1]' -c:a:1 aac -b:a:1 128k -profile:a:1 aac_low \
  -map '[a2]' -c:a:2 aac -b:a:2 160k -profile:a:2 aac_low \
  -map '[a3]' -c:a:3 aac -b:a:3 320k -profile:a:3 aac_low \
  -hls_time 10 -hls_list_size 0 -hls_playlist_type event \
  -hls_segment_filename '%v/segment%03d.ts' \
  -var_stream_map 'a:0,name:64k a:1,name:128k a:2,name:160k a:3,name:320k' \
  -f hls '%v/playlist.m3u8'
```

### Frontend: hls.js Integration

**File**: `src/utils/PlaybackManager.ts`

- `playUrl()` detects `.m3u8` URLs and routes to `playHls()`
- `playHls()` creates an `Hls` instance with `maxBufferLength: 60` (buffers 60s ahead)
- Auto seeds hls.js's ABR estimator from Network Information `downlink` when available; otherwise hls.js keeps Aurora's explicit 500 kbps cold-start estimate.
- hls.js remains in normal automatic level selection. `MANIFEST_PARSED` and `LEVEL_SWITCHED` update active bitrate, estimated bandwidth, rendition count, and switch count in in-memory playback telemetry. Fragment samples do not write to Zustand.
- A live Data Saver change caps `autoLevelCapping` at the 64 kbps level immediately. Native Safari HLS has no level-selection API, so it receives the capped master on the next load and reports `Auto` without an observable active rendition.
- Waits for `MANIFEST_PARSED` event before calling `safePlay()`
- iOS Safari fallback: uses native `<audio>` element with HLS src directly
- `safePlay()` handles `NotAllowedError` (autoplay blocked) gracefully
- If adaptive packaging or playback exhausts recovery, Aurora retries once at fixed 64 kbps with Data Saver or fixed 128 kbps otherwise, recording `fixed-quality-after-adaptive-failure`.

### Prewarm and prepared-track behavior

`POST /api/stream/:trackId/prewarm?quality=auto` prepares all renditions in one FFmpeg process. Conservative policy prepares the immediate next track. Aggressive policy may prewarm the next two server packages while retaining one local prepared `HTMLAudioElement` for promotion. Each Auto track still consumes one FFmpeg process, not one process per rendition. Offline, Data Saver, and 2G safeguards remain in the frontend prewarm manager; Data Saver playback itself still requests the 64 kbps Auto master.

### Packaging benchmark (2026-07-14)

Measured with reproducible 60-second 44.1 kHz pink-noise fixtures, one FLAC and one 160 kbps MP3, on the development host. Readiness is Aurora's two-segment threshold. Peak RSS and CPU/storage are full-process measurements, so they describe packaging cost rather than steady playback memory.

| Input / package | Renditions | Ready | Wall | User CPU | Peak RSS | Temp storage |
|---|---:|---:|---:|---:|---:|---:|
| FLAC, fixed 128 kbps | 1 | 268 ms | 0.32 s | 0.34 s | 70,612 KB | 1,040 KB |
| FLAC, Auto 64/128/160/320 | 4 | 503 ms | 1.30 s | 2.22 s | 72,384 KB | 4,468 KB |
| MP3 160 kbps, fixed 128 kbps | 1 | 271 ms | 0.33 s | 0.36 s | 69,532 KB | 1,040 KB |
| MP3 160 kbps, Auto 64/128/160 | 3 | 203 ms | 0.37 s | 0.95 s | 70,896 KB | 2,856 KB |

All generated rendition playlists had identical segment names and duration boundaries. Process inspection and FFmpeg arguments confirmed one FFmpeg process per Auto track. Adaptive and fixed temp sessions retain the same 30-minute inactivity cleanup contract.

### Client-Side Caching (Service Worker)

Configured via Workbox in `vite.config.ts`:

| Pattern | Strategy | Cache Name | TTL |
|---------|----------|------------|-----|
| `*.ts` segments | CacheFirst | `nl-audio-chunks-v1` | 7 days, 2000 entries |
| `*.m3u8` playlists | NetworkFirst | `nl-audio-playlists-v1` | 1 day, 200 entries |
| `/api/art` | CacheFirst | `media-cache` | 30 days, 500 entries |

Segments are immutable (cache-forever safe). Playlists use NetworkFirst so they're always fresh, with cache fallback for offline.

Adaptive Auto requests have an additional failure-only cache fallback. hls.js may choose a different rendition when a cached track is replayed offline, even though only the rendition used during the original playback exists in Cache Storage. Workbox still prefers an exact URL while online, but if that request fails it may reuse a cached playlist or time-aligned segment with the same track/path and different adaptive query parameters. This preserves live ABR behavior, makes already-cached Auto playback rendition-agnostic offline, and leaves fixed-quality and Source cache matching unchanged. Existing `nl-audio-*` cache names are retained so entries created before this behavior remain usable.

### Album Artwork

Covers are **pre-encoded to AVIF during library scans** rather than extracted and resized on every request. See "Album Artwork Pipeline" below. Because the cached art URL is keyed by the cover's content hash (`/api/art?hash=<hash>&size=<256|640|1024>`), every track on an album shares one URL — so the service worker stores **one** entry and the browser decodes **one** bitmap per album, not one per track. The hashed responses are served `immutable`, so a cache hit never revalidates.

## Audio Analysis Pipeline

### Overview
The application extracts acoustic features from audio files to power the recommendation engine (Infinity Mode, Hub playlists). This is implemented as a **three-phase process**:

1. **Metadata Phase** (Library Scan): ID3/Vorbis/ASF tags extracted and stored in PostgreSQL. The embedded cover is also encoded to AVIF here (see "Album Artwork Pipeline").
2. **Analysis Phase** (Worker Threads): ffmpeg + Python + TensorFlow extract high-dimensional feature vectors:
   - **8D Acoustic Vector** (Rhythm, style, and instrumentation)
   - **1280D Discogs-EffNet Embedding** (Neural timbre and production fingerprint)
3. **Feature Storage**: Results stored in `track_features` table with pgvector HNSW indexing for ultra-fast similarity search.

### Technical Implementation

#### ffmpeg Decoding
```
ffmpeg -ss <seek_to_35%> -i <input> -t 15 -f f32le -ac 1 -ar 44100 pipe:1
```
- **Smart Seeking**: Seeks to ~35% into the track (past intros/silence) to capture a representative segment of the chorus or main verse.
- **15-Second Window**: Captures sufficient audio for the ML models to generate stable embeddings while minimizing memory and CPU overhead.
- **Raw PCM Output**: Decodes once to 44.1 kHz, 32-bit little-endian float mono PCM for DSP. Essentia resamples that buffer to 16 kHz for both models; there is no second ffmpeg decode.

#### Python ML Engine
The analysis has transitioned from WASM-based processing to a dedicated **Python 3** engine using the **Essentia Python library** and **TensorFlow** models.

**MusiCNN (8D Acoustic Features)**:
Extracted using the MusiCNN classification model and traditional DSP algorithms:
1. **Energy** — Duration-independent RMS level, mapped linearly from -60 dBFS (0) to 0 dBFS (1).
2. **Brightness** (Spectral Centroid) — Frequency balance (high-frequency content proxy).
3. **Percussiveness** (Dynamic Complexity) — Rhythmic energy variation.
4. **Pitch Salience** — Reserved dimension, currently the constant 0.5.
5. **Instrumentalness** (ML-derived) — Probability that the track is instrumental.
6. **Acousticness** (ML-derived) — Probability of acoustic vs. synthetic instruments.
7. **Danceability** (ML-derived) — MSD MusiCNN “dance” tag (index 6), used as a proxy. Index 49 is “happy” and is not used for danceability.
8. **Tempo** — BPM divided by 200 and clamped to [0, 1]. Clips shorter than three seconds report unknown BPM as 0.

Short clips are repeated to a three-second minimum for model inference only; DSP uses the original audio. Empty, non-finite, wrong-dimension, and zero-norm model outputs are rejected. The worker protocol uses strict JSON, and the Node boundary validates vectors again before storage.

**Discogs-EffNet (1280D Neural Embedding)**:
The primary system for timbre and production similarity. It uses a **EfficientNet-based model** (Discogs-EffNet) to generate a high-fidelity **1280-dimensional** embedding.
- **Neural Timbre**: Captures the "texture" of the audio (e.g., tube saturation, reverb style, specific synthesizer characteristics).
- **L2 Normalization**: Embeddings are L2-normalized at extraction time to allow for **Cosine Similarity** search in PostgreSQL.

#### Worker Thread Architecture
```
Main Thread (Express Server)
  ├── Worker 1 → spawn("node --import tsx analyzeTrack.ts")
  │     └── persistent child_process → extractor.py (Python ML)
  ├── Worker 2 → spawn("node --import tsx analyzeTrack.ts")
  │     └── persistent child_process → extractor.py (Python ML)
  ...
```
- **Process Isolation**: Node.js manages a pool of `analyzeTrack.ts` workers. Each worker keeps one Python `extractor.py` process alive and sends multiple track jobs over stdin/stdout so the TensorFlow models load once per worker.
- **Resource Management**: `AURORA_ANALYSIS_THREADS` sets native threads per library (1–64, default 2), before NumPy/TensorFlow initialization.
- **Concurrency Control**: Worker counts are Background=1, Balanced=4, Performance=8, Intensive=16, Maximum=available CPUs. These selections are authoritative and independent of native thread counts or estimated memory usage. A batch with fewer tracks uses fewer workers. Setting changes resize an active pool.
- **Protocol**: Newline-delimited JSON over stdin/stdout
- **Process Lifetime**: Persistent child processes per worker, handling multiple tracks. On POSIX, each pool worker owns a separate process group. Timeouts, crashes, shrink, and shutdown kill that group (including Python/ffmpeg); pending jobs settle and timers clear. Windows uses `taskkill /t /f`. Unexpected failures respawn with a short backoff. Final stdout drains before exit settlement.

#### Filename Support
Paths are sent as base64 to the Node worker, decoded as UTF-8, and passed as subprocess arguments to Python/ffmpeg without a shell. Native regression tests cover Danish characters, em dashes, and apostrophes. Raw non-UTF-8 filesystem byte names are not covered by this path.

### Database Schema
```sql
CREATE TABLE track_features (
  track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE PRIMARY KEY,
  bpm NUMERIC,
  acoustic_vector_8d VECTOR(8),  -- 8D acoustic semantic
  embedding_vector VECTOR(1280), -- 1280D Discogs-EffNet Timbre
  is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
  feature_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX track_features_idx ON track_features USING hnsw (acoustic_vector_8d vector_cosine_ops);
CREATE INDEX track_features_effnet_idx ON track_features USING hnsw (embedding_vector vector_cosine_ops);
```

### Feature versions and reanalysis
Version 2 corrects the dance tag and energy mapping and uses a single decode plus resampling. Existing rows migrate to version 1. The next regular scan/analysis selects missing or outdated vectors and rewrites them with version 2; no scan is started by the migration itself. Failed extraction retains the existing explicit simulated-fallback behavior and is stamped with the attempted version, so it does not retry forever. Use **Re-analyze Fallbacks** to retry those failures. Loudness columns are preserved when feature vectors are replaced.

The extractor uses fixed per-feature mappings and L2-normalized embeddings. It does not use library-wide z-score statistics; the unused batch statistics query and worker payload have been removed.

Infinity reads acoustic and embedding seed vectors together and restricts similarity comparisons to the newest valid seed's feature version. This prevents mixing version 1's saturated energy/happy-tag values with version 2's RMS energy/dance-tag values during reanalysis. If that version has no eligible neighbors, the fallback can choose another unplayed track without comparing incompatible coordinates; queued/recent tracks and their duplicate editions remain excluded.

### Scanner verification

```bash
npx tsc --noEmit
npm test -- --runInBand
.venv/bin/python3 -B -m unittest discover -s server/workers -p 'test_*.py'
AURORA_MODEL_TESTS=1 .venv/bin/python3 -B -m unittest discover -s server/workers -p 'test_*.py'
AURORA_DB_TESTS=1 npm test -- --runInBand server/database/__tests__/readQueries.pg.test.ts
```

Native model tests require the installed Essentia/TensorFlow environment, ffmpeg/ffprobe, and both model files. Database tests create and remove a temporary database. Unit coverage includes crash/timeout/shutdown settlement, process-group targeting, EPIPE, resizing, buffered final results, invalid model outputs, energy duration invariance, the dance-tag mapping, and single-decode behavior.

### Processing diagnostics

Admins can enable independent **Library scanner**, **Audio analyzer**, and **Loudness computation** switches in **Settings → System & Processing → Logging**. Each change saves immediately to the server and applies to active jobs without restarting workers. Failed saves show an error and leave the switch unchanged. These settings are server-wide and survive restarts.

Scanner diagnostics cover auto-walk, scan phases, and metadata jobs. Analyzer diagnostics cover worker activity, per-track timings, and Python/TensorFlow output. Loudness diagnostics cover measurement duration, integrated LUFS, and true peak for both scan-time and lazy playback measurements. They default to off; `LOG_SCANNER`, `LOG_ANALYZER`, and `LOG_LOUDNESS` provide environment defaults until an explicit setting is saved.

Actual failures and actionable warnings remain visible with diagnostics off, including Python failure details. Worker diagnostics use stderr separately from the stdout result protocol. HLS and streaming FFmpeg retain their own independent switches; HLS session files are unaffected.

### Scanner measurements (2026-10-06)

An isolated synthetic benchmark used four persistent workers and twenty analyses of the same 15-second 44.1 kHz sine-wave WAV (five per worker), including model startup. This is a local resource comparison, not a full-library throughput guarantee.

| Metric | Before | Corrected extractor (2 native threads) |
|---|---:|---:|
| Batch wall time | 6.177 s | 6.325 s |
| Throughput | 3.238 tracks/s | 3.162 tracks/s |
| Mean decode + resample time | 151.0 ms | 111.0 ms |
| Peak RSS per Python worker | 928–967 MiB | 771–785 MiB |
| Threads per Python worker | 49 | 7 |

One native thread reduced memory further but materially reduced throughput, so two is the default. A separate 30-job run reached about 677 MiB resident memory; growth flattened between jobs 20 and 30 (676.2 to 676.7 MiB). The original 600 MB target is still unmet by the installed bs64 EffNet model. Allow roughly 1 GiB per worker when selecting concurrency; the server does not silently reduce the selected process count.

Native Linux verification also confirmed that a deliberately paused Python descendant is killed on pool timeout and that the real Node→Python pipeline completes repeated short Unicode-path jobs. Windows tree termination has not been runtime-verified.

### Timbre-Weighted EffNet Similarity
For electronic/synthetic playlists (target acousticness < 0.3), Discogs-EffNet embedding similarity is weighted more heavily in the SQL query to prioritize instrument texture and production character over rhythm alone.

### SQL-Level Acousticness Dealbreaker
An asymmetric penalty applied in SQL: if the playlist targets EDM (acousticness < 0.2) but a track is fully acoustic (> 0.5), it receives a +5.0 distance spike at the query level.

## Album Artwork Pipeline

Local covers are encoded once, at ingestion time, instead of being extracted and resized on every request. This removes a per-request audio-file parse and, more importantly, caps decoded-bitmap memory in the browser (a full-resolution cover can be 1000–3000px; a grid of them decoded at full size used to consume hundreds of MB and could OOM mobile tabs).

**Resolution and encoding (scan time).** During the Metadata Phase, the `scanTrack` worker validates every embedded picture with `sharp`. It prefers front-cover images, then square/high-resolution candidates. ASF/WMA recovery removes bytes before a recognized image header and reconstructs JPEG streams whose SOI/JFIF prefix was lost, accepting a repair only when `sharp` can decode it. If no embedded candidate is valid, Aurora checks the track directory in this order: `cover`, `folder`, `front`, `AlbumArt*_Large`, then `AlbumArt*_Small`/`AlbumArtSmall` (JPEG, PNG, WebP, or AVIF). Unrelated images are ignored.

The chosen local image is hashed (SHA-256, first 32 hex chars) and encoded to AVIF variants at **256 / 640 / 1024 px** via `sharp` (`quality 62`, `effort 4`). Files are written to `ART_CACHE_DIR` (default `./art-cache`), sharded by hash prefix: `art-cache/<ab>/<hash>_<size>.avif`. Encoding is keyed by content hash and skips any variant already on disk, so an album's tracks that share identical art produce **one** file set.

**Change detection and parser upgrades.** `tracks.file_mtime` is recorded per file. A scan reprocesses a file when it is new **or** its mtime changed (a re-tag), so replaced embedded covers are re-encoded; the displaced hash is removed if no other track still references it. `tracks.artwork_version` records which resolver processed the file. When recovery logic changes, only stale rows are queued for a one-time automatic metadata pass. The WMA recovery upgrade specifically leaves previously artless `ASF/audio` rows stale, while successful and non-WMA rows are seeded current. A completed attempt is stamped current even when no local art exists, preventing repeated work on genuinely artless files. Use **Settings → Library → Refresh Metadata** to force a complete folder re-read or pick up a newly-added folder image when the audio file mtime did not change.

**Serving.** `tracks.art_hash` stores the local result (`NULL` = not yet processed, `''` = no local art, otherwise the hash). `GET /api/art` serves:
- `?hash=<hash>&size=<256|640|1024>` → streams the pre-encoded AVIF directly, `Cache-Control: immutable`.
- `?pathB64=<path>` → serves cached local art, performs live normalized embedded/folder resolution when the row is stale or the cache was cleared, then consults the configured album-art provider and redirects through the allowlisted external-image proxy. If every source fails it returns `404`.

The client requests a hash URL when `art_hash` is known (see `buildTrackUrls`) and appends `&size=` per context via `AlbumArt` (grids 256, detail hero 640, now-playing up to 1024). Artless tracks retain the path-addressed URL, so the same provider result reaches album views, player controls, queues, Media Session, Cast, and OpenSubsonic `getCoverArt` instead of being implemented separately in each UI component. Local artwork always wins.

**Operational notes.** `ART_CACHE_DIR` is a derived cache — safe to delete; it rebuilds on the next scan or Refresh Metadata, so it does not need to be backed up. `sharp` is a runtime dependency (native module); `npm ci` installs the prebuilt binary on Linux automatically.

## Audio Processing (Planned)
- **Web Audio API**: The audio element is wrapped with an `AudioContext` (initialized on first user interaction). Currently routes `MediaElementAudioSourceNode` → `destination`.
- **Future Chain**: `MediaElementAudioSourceNode` → `GainNode` (Volume) → `BiquadFilterNodes` (EQ) → `AnalyserNode` (Visualizer) → `destination`.
- **Cross-fade**: Orchestrated by dual gain-node ramps during track transitions.
- **Gapless**: Leveraging `audioContext.currentTime` and look-ahead buffering to schedule next track starts with micro-second precision.

## WMA Support
- **Transcoding**: WMA files are transcoded to AAC on-the-fly via the HLS pipeline (same as other formats when quality < source bitrate)
- **Legacy fallback**: Direct WMA → MP3 pipe streaming is preserved in the `/api/stream` legacy endpoint
- **Format Detection**: File extension-based MIME type mapping in `MIME_TYPES` record
- **Artwork recovery**: Malformed `WM/Picture` offsets, missing JPEG SOI/JFIF prefixes, multiple embedded pictures, and conventional Windows Media folder artwork are normalized through the shared album-art resolver
