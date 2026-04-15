# Engine Settings & Hub Lifecycle

This document outlines the architecture for the user-facing Settings menu, how state is passed to the recommendation engine, and the **Aurora Media Server** lifecycle for LLM-driven discovery.

## 1. Engine Tuning (Settings UI -> Backend Mapping)

The UI exposes human-readable parameters that map directly to the backend mathematical search variables.

### 1.1 Playback & Discovery Tab
- **Discovery Level (The Wander Factor)**: Slider (1-100). Sets a rank-weighted randomizer that selects from the top candidates to ensure serendipity.
- **Genre Strictness**: Slider (0-100). Maps to `genreWeight` in the recommendation engine.
  - *0*: Pure acoustic/embedding similarity (ignores genre).
  - *100*: Absolute genre adherence (penalizes jumping outside the MBDB genre branch).
- **Genre Penalty Curve**: Slider (0-100). Controls the steepness of the exponential penalty applied to tracks outside the target genre cluster.
- **Artist Amnesia**: Dropdown ("Standard", "Strict"). Controls how many recent artist identifiers are excluded from the candidate pool to prevent repetition.

### 1.2 System & Processing Tab
- **Audio Analysis Workers**: Dropdown ("Background", "Balanced", "Maximum"). Controls the worker thread pool for audio feature extraction:
  - *Background*: 1 worker thread (Minimal impact).
  - *Balanced*: 4 worker threads (Default).
  - *Maximum*: Auto-scales to all logical CPU cores via `os.cpus().length`.
  
  Each worker manages a lifecycle that includes an FFmpeg decode step followed by spawning the **Python `extractor.py`** ML engine.

## 2. Three-Phase Scanner Architecture

1. **Walk Phase**: Recursive directory traversal using Node.js Buffers to collect raw paths.
2. **Metadata Phase**: High-speed parallel tag parsing via `music-metadata`. Tracks become visible in the library after this phase.
3. **Analysis Phase**: Audio feature extraction via the **Python ML Engine**:
   - ffmpeg seeks to ~35% (the track core).
   - Python `extractor.py` runs **MusiCNN** and **Discogs-EffNet** models.
   - Generates **1288-dimensional** feature vectors (**8D acoustic** + **1280D EffNet**).
   - Features stored in the PostgreSQL `track_features` table.

## 3. External Providers (LLM & Metadata)

Aurora uses a "Bring Your Own Key" model. All credentials and external service settings are stored in the PostgreSQL `system_settings` or `user_settings` tables:

- **LLM Configuration**: Supports OpenAI-compatible endpoints (including local providers like Ollama, LocalAI, and LM Studio).
- **Metadata Providers**: API keys for Genius (Lyrics), Last.fm (Scrobbling), and MusicBrainz (OAuth) are stored encrypted or securely in the database.

## 4. The Hub Lifecycle

To ensure performance, the Hub follows a discrete **Generation vs. Fetching** pattern:

- **Fetching (GET /api/hub)**: Returns immediately from the `playlists` table where `is_llm_generated = true`. It **never** triggers an LLM call.
- **Generation (POST /api/hub/regenerate)**: Triggers the LLM context processor, runs the similarity search across the 1288D vector space, and saves new playlists to the database. This runs via a background interval (e.g., Daily) or a manual "Refresh" trigger.
