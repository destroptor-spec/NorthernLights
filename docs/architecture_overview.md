# Architecture Overview

```mermaid
graph TD
    UI[React UI] --> Store[Zustand Store]
    Store --> FE_API[Frontend Library API]
    FE_API --> BE_API[Node.js + Express API]
    BE_API --> PostgreSQL[(PostgreSQL + pgvector)]
    BE_API --> FS[Host File System]
    BE_API --> Scanner[Three-Phase Scanner]
    Scanner --> Walk[Phase 1: Directory Walk]
    Scanner --> Metadata[Phase 2: Metadata Extraction]
    Scanner --> Analysis[Phase 3: Audio Analysis]
    Analysis --> Workers[Worker Thread Pool]
    Workers --> Essentia[Essentia WASM + ffmpeg]
    FS --> Stream[HTTP Streaming /api/stream]
    Stream --> Audio[HTML5 Audio Engine]
    Store --> Audio
    BE_API --> LLM[LLM Hub Integration]
    BE_API --> Chromecast[Google Cast SDK]
```

### 1. UI Layer
- **React + TypeScript**: Modular components using Tailwind CSS for responsive styling.
- **Glassmorphism System**: Frosted glass aesthetics with persistent theme context (Light/Dark).
- **React Router**: UUID-based entity navigation with browser history support.

### 2. State & Audio Engine
- **Zustand Store**: Unified state management for library metadata, playback queue, and session settings.
- **PlaybackManager**: Singleton wrapper around `HTMLAudioElement` providing gapless transitions and global playback control.
- **CastManager**: Google Cast (Chromecast) integration for audio streaming to cast devices.

### 3. Backend Infrastructure
- **Node.js + Express**: Manages local file scanning, ID3/Vorbis/ASF metadata extraction, audio serving, and LLM integration.
- **PostgreSQL + pgvector**: Persistent storage for library tracks, mapped directories, playback history, and 7-dimensional acoustic feature vectors for similarity search.
- **HTTP Streaming**: Efficient server-side streaming via `Range` headers to support large HQ audio files (FLAC, MP3, WMA, etc.).
- **Container Orchestration**: Podman/Docker support for PostgreSQL container management via `containerControl.service.ts`.

### 4. Three-Phase Scanner Architecture
The library scanner operates in three distinct phases for transparency and reliability:

1. **Walk Phase**: Recursive directory traversal collecting audio file paths (MP3, FLAC, OGG, M4A, AAC, WMA).
2. **Metadata Phase**: Parallel ID3/Vorbis/ASF tag extraction using `music-metadata` library. Stores track info (title, artist, album, genre, duration) in PostgreSQL.
3. **Analysis Phase**: Audio feature extraction via worker threads:
   - **Worker Thread Pool**: CPU-intensive Essentia WASM processing offloaded from main thread
   - **Smart Seeking**: ffmpeg seeks to ~35% into track (past intro) for representative chorus/verse analysis
   - **Symlink Workaround**: Non-ASCII filenames handled via temp symlinks in `/tmp/am-*/`
   - **Safe Essentia**: Individual algorithm error handling with graceful fallbacks

### 5. Audio Analysis Pipeline
- **ffmpeg**: Decodes 15 seconds of audio from 35% seek point to raw float32 PCM
- **Essentia.js**: WASM-based audio analysis extracting 7-dimensional feature vectors:
  - Energy, Brightness (spectral centroid), Percussiveness, Chromagram (pitch), Instrumentalness, Acousticness, Danceability
- **Z-Score Normalization**: Features normalized against rolling library statistics for consistent similarity search

### 6. File System Integration
- **Directory Mapping**: Users provide absolute server paths to ingest local music folders.
- **Non-ASCII Support**: Raw Buffer paths with symlink workaround for special characters (Danish `øæ`, em-dashes, apostrophes).
- **Background Scanning**: Non-blocking worker threads for deep directory traversal, metadata parsing, and audio analysis.

### 7. Recommendation Engine
- **pgvector + HNSW**: Fast approximate nearest neighbor search on 7D acoustic vectors
- **Macro-Genre Ontology**: 39-genre classification system with LLM-assisted categorization
- **Infinity Mode**: Real-time playlist generation based on acoustic similarity and user preferences
- **Hop Costs**: Genre transition penalties for coherent playlist flow

### 8. Utilities & Testing
- **Metadata Parser**: Integrated support for FLAC (Vorbis), MP3 (ID3), M4A, AAC, WMA via `music-metadata`.
- **Worker Threads**: CPU-intensive analysis isolated from main event loop for server responsiveness.
- **Test Suite**: Jest + React Testing Library for verifying store logic and queue manipulation.
