# Engine Settings & Hub Lifecycle

This document maps the listener-facing `Playback -> LLM Playlists` controls to the current backend behavior and describes how Hub playlist generation moves from raw LLM concepts to saved playlists.

## 1. Playback -> LLM Playlists

Aurora exposes a listener-oriented tuning model. The UI does not send abstract recommendation-engine internals directly; it sends stable numeric settings that shape concept compilation, pool construction, recovery, and final selection.

### 1.1 Basic Controls

- **Number of Playlists** (`llmPlaylistCount`, default `3`)
  - How many Hub concepts the backend tries to generate per run.
  - Regeneration retries dropped concepts up to three times to reach this count.

- **Tracks per Playlist** (`llmTracksPerPlaylist`, default `10`)
  - Target playlist length for Hub and custom LLM playlists.
  - Also raises the viability thresholds for artist depth and song count during recovery.

- **Genre Cohesion** (`llmGenreCohesion`, default `50`)
  - Replaces the older `genreBlendWeight` model.
  - Controls how strongly the recommender keeps a playlist near the compiled target paths versus drifting into adjacent, acoustic, bridge, and discovery pools.

- **Playlist Diversity** (`llmPlaylistDiversity`, default `50`)
  - Controls how much the selector favors novelty, pool spread, album spread, and acoustic spread over pure fit.
  - Higher values increase the chance of blended, less repetitive playlists.

- **Discovery Bias** (`llmDiscoveryBias`, default `45`)
  - Increases pressure toward `discovery` and `bridge` candidates.
  - Helps weaker concepts recover without becoming artist-locked.

- **Artist Spread** (`llmArtistSpread`, default `70`)
  - Tightens per-artist concentration limits and artist-repeat penalties.
  - Higher values push long playlists toward more distinct artists.

- **Banned Genre Handling** (`llmVetoMode`, default `hard`)
  - `hard`: banned genres are absolute exclusions.
  - `adaptive`: banned genres remain hard during normal generation, but can become strong penalties during late recovery when the playlist would otherwise fail.

### 1.2 Advanced Controls

- **Recovery Strength** (`llmRecoveryStrength`, default `50`)
  - Controls how aggressively the ladder expands beyond exact-path matching into adjacent, root, acoustic, bridge, and discovery recovery.

- **Adjacent Reach** (`llmAdjacentReach`, default `50`)
  - Controls how far the concept compiler may expand into nearby MusicBrainz hierarchy paths.
  - Higher values allow broader adjacent-path support when the exact local genre slice is weak.

- **Genre Penalty Curve** (`genrePenaltyCurve`, default `50`)
  - Controls the steepness of hop-cost penalties during genre-aware re-ranking.
  - Backend mapping:

```ts
const penaltyCurve = 0.5 + (genrePenaltyCurve / 100) * 1.5;
```

This yields a working range of `0.5 -> 2.0`.

## 2. Settings Flow

### 2.1 Persistence

- Frontend state lives in the Zustand store.
- User settings are loaded and saved through `/api/settings`.
- The backend persists listener-tunable values in `user_settings`.
- Server-wide settings remain in `system_settings`.

### 2.2 Backward Compatibility

`llmGenreCohesion` falls back to the legacy `genreBlendWeight` value if a user has not resaved settings since the tuning redesign. This keeps old installs working while the new control names are adopted.

## 3. Three-Phase Scanner Architecture

Audio analysis is handled by a Node-managed child-process pool. Each `tsx` analyzer worker keeps a persistent Python extractor process alive, so TensorFlow models load once per worker instead of once per track.

1. **Walk Phase**
   - Recursively collects candidate audio file paths.
   - No metadata or feature extraction yet.

2. **Metadata Phase**
   - Uses `music-metadata` to extract title, artist, album, genre, duration, and IDs.
   - Tracks become visible in the library after this phase.

3. **Analysis Phase**
   - Uses `server/workers/processPool.ts` to manage concurrent `tsx analyzeTrack.ts` workers.
   - Each `tsx` worker communicates with `server/workers/extractor.py` over newline-delimited JSON.
   - `ffmpeg` seeks to roughly 35% into the track and decodes representative 15-second windows.
   - Essentia TensorFlow models extract the semantic feature set used by recommendations.
   - The recommender stores:
     - 8D acoustic vectors for playlist concept matching and selector spread
     - 1280D Discogs-EffNet embeddings for richer timbre and production similarity

## 4. Hub Generation Lifecycle

Hub generation is intentionally split into **fetch** and **regenerate**.

### 4.1 Fetch

- `GET /api/v1/hub`
- Reads existing saved LLM playlists for the user.
- Does not call the LLM.
- Does not rebuild playlists on demand.

### 4.2 Regenerate

- `POST /api/v1/hub/regenerate`
- Deletes stale LLM playlists for the requesting user.
- Reads recent listening history to provide time-of-day context and short-term taste context to the LLM.
- Loads the current LLM tuning settings for the user.
- Requests enough concepts to reach `llmPlaylistCount`, retrying dropped concepts up to three attempts.

### 4.3 Concept Compilation

Each raw LLM concept is compiled into a local-library-relative plan:

- target path resolution against the MusicBrainz hierarchy
- primary genre health lookup
- adjacent path expansion
- target-vector adaptation into local library percentiles
- bridge-vector generation toward the local library mainstream
- conflict sanitization against banned genres
- concept-quality scoring to reject weak broad-only plans before execution

The compiler emits modes such as:

- `genre-anchored`
- `hybrid`
- `acoustic-only`

### 4.4 Named Candidate Pools

The generator builds independent candidate pools:

- `core`
- `adjacent`
- `root`
- `acoustic`
- `discovery`
- `bridge`

Each pool is deduplicated and measured independently before being merged into the ranked candidate set.

### 4.5 Recovery Ladder

If the concept is weak in the local library, the engine relaxes deterministically:

1. `exact-path`
2. `adjacent-path`
3. `same-root`
4. `acoustic-similarity`
5. `mood-bridge`
6. `discovery-backfill`

The highest level reached is logged and also changes downstream behavior:

- genre anchoring remains active only through root-level recovery
- adaptive veto recovery is only allowed in late recovery
- long playlists can trigger a second-pass refill if artist spread or diversity is still too weak

### 4.6 Final Selection

Aurora does not do a simple top-N pick.

The final selector is a constrained optimizer that applies:

- same-song deduplication
- cross-playlist duplicate prevention
- artist concentration caps
- album penalties
- genre-root penalties
- acoustic-cluster penalties
- pairwise similarity penalties
- pool-balance targets
- controlled randomness

If reranking collapses despite healthy admissible pools, the generator falls back to direct admissible-row selection instead of dropping the playlist.

### 4.7 Diagnostics

Every generated playlist emits a compact diagnostic block summarizing:

- compiled targets and adjacent expansion
- health and effective blend
- veto mode
- pool sizes
- relaxation ladder snapshots and reached level
- anchor state
- selected pool mix
- diversity metrics

This is the intended live-tuning surface when validating behavior on real local libraries.
