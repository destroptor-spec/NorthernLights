# Smart Music Recommendation Engine

The recommendation engine utilizes a hybrid multi-vector architecture:
- **8D Acoustic Semantic Vectors**: Representing high-level rhythmic and stylistic features.
- **1280D Discogs-EffNet Embeddings**: High-fidelity instrument and timbre identification.
- **Two-Pool Logic**: A CTE-based retrieval system that balances genre strictness with serendipitous embedding-based discovery.
- **pgvector Integration**: Uses HNSW indexing for approximate nearest neighbor search across both vector spaces.

## 1. Database Schema (PostgreSQL + pgvector)

**Table: `track_features`**
- `track_id` TEXT REFERENCES tracks(id) ON DELETE CASCADE PRIMARY KEY
- `bpm` NUMERIC
- `acoustic_vector_8d` VECTOR(8) — Acoustic semantic features (L2 distance `<->`)
- `embedding_vector` VECTOR(1280) — Discogs-EffNet timbre/texture embeddings (Cosine distance `<=>`)
- `mfcc_vector` (legacy) — 13D vector replaced by 1280D EffNet.
- `acoustic_vector_7d` (legacy) — Vector(7) for backward compatibility.

**8D Acoustic Semantic Features** (in order):
`[energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability, tempo]`

**13D MFCC Timbre Features**: Mel-frequency cepstral coefficients capturing instrument texture and harmonic characteristics.

**Indexes:**
```sql
CREATE INDEX track_features_idx ON track_features USING hnsw (acoustic_vector_8d vector_cosine_ops);
CREATE INDEX track_features_effnet_idx ON track_features USING hnsw (embedding_vector vector_cosine_ops);
```

## 2. Background Worker Architecture
Audio extraction runs in worker thread pools (1-6 concurrent workers) via `tsx` child processes:
- Smart seeking: ffmpeg seeks to ~35% into track (past intro)
- 15-second decode window for representative analysis
- Non-ASCII filenames handled via temp symlinks in `/tmp/am-*/`
- NaN guards and dimension validation on all extracted vectors

## 3. Normalization
Features are normalized using native SQL aggregation:
```sql
SELECT AVG(acoustic_vector_8d), STDDEV(acoustic_vector_8d) FROM track_features
```
Z-score normalization applied per-dimension, then sigmoid to [0,1] range.

## 4. Querying (The Two-Pool Architecture)
The engine utilizes a Common Table Expression (CTE) to fetch tracks from two distinct pools, blending them based on the `genreBlendWeight` setting.

### Pool A: Genre-Constrained Discovery
- **Logic**: Filters strictly by hierarchical genre path (e.g., `electronic.dance.%`).
- **Distance**: Calculated primarily via the **8D Acoustic Vector** using L2 distance (`<->`).
- **Goal**: Ensures thematic consistency within the target genre.

### Pool B: Serendipity (Embedding-Space)
- **Logic**: Genre-blind search across the entire library.
- **Distance**: Hybrid score blending **8D Acoustic Distance** + (**1280D EffNet Distance** * `effnetWeight`).
- **Operator**: Uses Cosine Distance (`<=>`) for the 1280D embeddings.
- **Goal**: Finds "sonically similar" tracks that might belong to different genres.

### Pool Balancing
The relative size of each pool is determined by `genreBlendWeight`:
- **limitA** = `fetchSize * genreBlend`
- **limitB** = `fetchSize - limitA`

### 4.1 EffNet Imputation
The LLM typically generates an 8D target vector. Since there is no 1280D target from the LLM, the engine **imputes** a 1280D centroid:
1. Fetch 20 closest 8D neighbors to the target.
2. **Relative Cliff Check**: If the 5th neighbor's distance is > 0.5 further than the 1st, the neighborhood is considered sparse/poisoned and imputation is aborted.
3. Average and L2-normalize the 1280D embeddings of valid neighbors to create the target centroid.

## 5. Genre Penalty (Post-SQL Re-ranking)
After SQL fetch, tracks are re-ranked with an exponential genre penalty:

```typescript
const combined = distance * Math.pow(1 + hopCost, weight * curve);
```

Where `hopCost` comes from the LCA-based genre adjacency system and `curve = 0.5 + (genrePenaltyCurve / 100) * 1.5`.

**Hard Veto**: `banned_genres` from the LLM are applied as absolute exclusions — matching tracks get `combined: Infinity`. The veto checks against the full hierarchical path (e.g., banning "dance" catches `electronic.dance.trance`, `electronic.dance.dubstep`, etc.).

## 6. Anti-Repetition & Deduplication
- **Wander Factor**: A rank-weighted randomizer that selects from the top candidates to ensure serendipity.
- **History Penalty**: Excludes recently played Track IDs via `NOT IN` clauses.
- **Same-Song Deduplication**: 
  - Uses `mb_recording_id` for perfect identity matching.
  - Fallback: Uses **Normalized Title** matching (stripping "Remastered", years, and edition markers) and exact Artist matching.
  - Prevents the engine from suggesting the same song from a different album or a "Best Of" compilation.
- **Cross-playlist Deduplication**: Assigned track IDs are tracked across a Hub generation session.

## 7. The Hub (LLM-Driven Playlists)

### 7.1 Generation Pipeline
1. **Context**: Cron job summarizes listening history + time-of-day
2. **LLM Prompt**: Creative Director role, generates 3 playlist concepts with:
   - `target_vector` (8D acoustic profile)
   - `target_genres` (2-3 genre keywords from 300-genre vocabulary)
   - `banned_genres` (2-5 excluded genres)
3. **SQL Query**: 21D distance search with timbre weighting
4. **Re-ranking**: Genre penalty + hard veto + wander selection
5. **Persistence**: Saved as playlists with cross-playlist deduplication

### 7.2 Vocabulary-Guided LLM
Both Hub and custom playlist prompts are constrained to a vocabulary of actual genres:
- Library-scoped: < 300 genres → all library genres
- MBDB-capped: ≥ 300 genres → top 300 from MBDB hierarchy
- Prevents hallucinated genre names that don't match DB entries

## 8. Infinity Mode

### 8.1 Weighted Decay Centroid
Target vector computed from last 10 tracks with exponential decay (lambda=0.8). Applies to both 8D acoustic and 13D MFCC vectors.

### 8.2 Momentum Tracking
Energy/danceability delta across last 3 tracks. Positive trend → slight positive multiplier on target energy.

### 8.3 Penalty Formula
```typescript
const finalScore = row.distance * Math.pow(1 + hopCost, genreWeight / 3.0);
```
Multiplicative model consistent with Hub playlists. `genreWeight = (genreStrictness / 100) * 3.0`.

### 8.4 Relaxation Loop
If fewer candidates than target, expand pool size and relax `genreWeight *= 0.75` per iteration.
