# Antigravity Context: Settings UI, LLM Config & Hub Lifecycle

## System Overview
This document outlines the architecture for the user-facing Settings menu, how state is passed to the recommendation engine, and **critical architectural corrections** regarding LLM API key storage and the Hub generation lifecycle. 

**CRITICAL APP CONTEXT:** This is a locally-hosted web application. The user brings their own music and their own LLM API keys. DO NOT assume a cloud SaaS environment. DO NOT store user API keys in a `.env` file.

---

## 1. Engine Tuning (Settings UI -> Backend Mapping)
The UI must expose human-readable tuning parameters that map directly to the backend mathematical variables.

**1.1 The "Playback Algorithm" Tab (Live Queue & Infinity Mode)**
- **Discovery Level (The Wander Factor):** Slider (1-100). Maps to the `limit` (over-fetch pool) and the randomizer weight. 
  - *Low:* Fetch top 5, heavily weight index 0. 
  - *High:* Fetch top 50, distribute weight evenly.
- **Genre Strictness:** Slider (0-100). Maps to the `genreWeight` multiplier for Infinity Mode.
  - *0:* `genreWeight = 0.0` (Ignore genre, pure math).
  - *100:* `genreWeight = 3.0` (Heavily penalizes jumping outside the current genre cluster).
- **Genre Penalty Curve:** Slider (0-100). Controls the steepness of the exponential penalty curve for Hub playlists.
  - *0:* Lenient (curve=0.5) — aliens can win with modest acoustic advantage.
  - *100:* Strict (curve=2.0) — aliens need 2.2×+ closer acoustically.
  - Shows live penalty preview table (deep siblings, cousins, share root, alien multipliers).
- **Genre Blend Weight:** Slider (0-100). Overall genre influence strength for Hub playlists.
- **Artist Amnesia:** Dropdown ("Allow Repeats", "Standard", "Strict"). Maps to the length of the `recently_played_artist_ids` array passed to the Postgres `NOT IN (...)` query.

**1.2 The "System & Processing" Tab**
- **Audio Analysis CPU Usage:** Dropdown ("Background", "Balanced", "Maximum"). Controls the worker thread pool concurrency for audio feature extraction:
  - *Background:* 1 worker thread — minimal CPU impact, slowest analysis
  - *Balanced:* 4 worker threads — default setting
  - *Maximum:* 6 worker threads — fastest analysis, higher CPU usage
  
  Workers run in separate Node.js processes via `tsx` child processes, keeping the main event loop responsive for HTTP requests.
  
- **Hub Generation Schedule:** Dropdown ("Manual Only", "Daily", "Weekly"). Adjusts the cron job frequency for the LLM pipeline. Also create a button on the hub to generate or regenerate.

**1.3 State Management Implementation**
These settings must be instantly accessible. Store them in a frontend global state manager (Zustand/React Context). When requesting a new track, attach the values to the payload:
```typescript
interface PlaybackRequestPayload {
  targetVector: number[];
  currentGenre: string;
  settings: {
    discoveryLevel: number;
    genreStrictness: number;
    artistAmnesiaLimit: number;
  }
}
```

## 2. Three-Phase Scanner Architecture

The library scanner operates in three distinct phases for transparency and reliability:

### Phase 1: Directory Walk
- Recursive traversal of mapped folders
- Collects audio file paths (MP3, FLAC, OGG, M4A, AAC, WMA)
- No database writes during this phase

### Phase 2: Metadata Extraction
- Parallel ID3/Vorbis/ASF tag parsing via `music-metadata`
- Stores track metadata (title, artist, album, genre, duration, etc.)
- Creates artist/album/genre entity records
- Tracks visible in library immediately after this phase

### Phase 3: Audio Analysis (Worker Threads)
- CPU-intensive feature extraction offloaded from main thread
- Each worker spawns a persistent `tsx` child process
- Smart seeking: ffmpeg seeks to ~35% into track (past intro)
- Decodes 15 seconds for Essentia.js WASM and Tensorflow analysis
- 1288-dimensional feature vectors stored in `track_features` table (8D acoustic + 1280D EffNet embedding)
- Powers Infinity Mode and Two-Pool Hub similarity search

**API Endpoints:**
- `POST /api/library/scan` — Full three-phase scan (walk → metadata → analysis)
- `POST /api/library/analyze` — Analysis phase only (tracks without features)
- `GET /api/library/stats` — Per-directory coverage statistics

## 3. External Providers & API Configuration (CRITICAL)

Antigravity, do NOT use .env files for the user's LLM credentials. The user must be able to configure this dynamically via the UI to support local providers like Ollama or LM Studio.

- The UI: The Settings page must have an "External Providers" section with text inputs for API Base URL (defaults to OpenAI), API Key, and Model Name.
- The Storage: Store these values securely in a local Postgres settings table.
- The Execution: The Node.js backend must dynamically read these values from the database when instantiating the LLM client (e.g., the OpenAI Node SDK).

## 4. The Hub Generation Lifecycle (Bug Prevention)

Antigravity, you must separate the LLM generation trigger from the data fetching. The Hub MUST NOT trigger the LLM every time the user clicks the "Hub" tab.

- **Route A (The Fetcher):** GET /api/hub
  This route is called when the frontend component mounts. It MUST ONLY read from the hub_cache database table and return the data instantly. It must never trigger the LLM.

- **Route B (The Generator):** POST /api/hub/generate
  This route triggers the heavy LLM Prompt-to-Query pipeline, runs the Postgres Euclidean distance queries, overwrites the hub_cache table with the new playlists, and returns a success status. This is ONLY triggered by the background cron job (configured in 1.2) or a manual "Refresh Hub" button in the UI.
