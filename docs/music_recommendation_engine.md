# Smart Music Recommendation Engine

The recommendation engine utilizes a hybrid multi-vector architecture designed for high-fidelity similarity search and complex, context-aware playlist generation.

## 1. Core Architecture
- **8D/10D Acoustic Vectors**: Representing high-level rhythmic and stylistic features (Energy, Danceability, etc.).
- **1280D Discogs-EffNet Embeddings**: High-fidelity neural embeddings for instrument, timbre, and production fingerprinting.
- **Two-Pool Logic**: A balance between strict genre-based filtering and serendipitous embedding-based discovery.
- **pgvector + HNSW**: Native PostgreSQL vector search with HNSW (Hierarchical Navigable Small World) indexing for ultra-fast, approximate nearest neighbor retrieval.

## 2. Database Schema (PostgreSQL)

The system is fully migrated to **PostgreSQL v15+** with the **pgvector** extension. All feature data is stored in the `track_features` table:

- `track_id`: Primary key linking to the `tracks` table.
- `acoustic_vector_8d`: `VECTOR(8)` — Acoustic semantic features. Optimized for Euclidean distance (`<->`).
- `embedding_vector`: `VECTOR(1280)` — Discogs-EffNet embeddings. Optimized for Cosine distance (`<=>`).
- `is_simulated`: Boolean flag for tracks using fallback/simulated features.

### 8D Acoustic Semantic Features
The base acoustic profile consists of 8 dimensions (normalized to `[0, 1]`):
`[energy, brightness, percussiveness, pitch_salience, instrumentalness, acousticness, danceability, tempo]`

### 1280D Discogs-EffNet Embeddings
This is the primary engine for "sonic fingerprinting." It captures deep acoustic signatures of instruments and production styles, allowing the engine to find tracks with similar "vibes" even across disparate genres.

## 3. The Two-Pool Query Model

To ensure a balance between accuracy and serendipity, the engine uses a **Common Table Expression (CTE)** query that pulls tracks from two distinct pools:

### Pool A: Genre-Constrained (Precision)
- **Filters**: Strictly follows the hierarchical genre path (e.g., `modern_ambient.drone`).
- **Distance**: Calculated using the **8D Acoustic Vector**.
- **Role**: Ensures that the core of the playlist stays true to the requested genre.

### Pool B: Serendipity (Discovery)
- **Filters**: Genre-blind; searches the entire library.
- **Distance**: A hybrid score: `(8D Acoustic Distance) + (1280D EffNet Distance * multiplier)`.
- **Role**: Discovers tracks that "feel" right for the concept but might be cross-genre (e.g., finding a Jazz track that fits an "Ambient Electronic" vibe).

## 4. Discovery Mechanisms

### EffNet Imputation (Centroid Synthesis)
Since the LLM (Large Language Model) only generates an 8D acoustic target, the engine **imputes** a 1280D target centroid for high-fidelity search:
1. Identify the 20 closest 8D acoustic neighbors.
2. Perform a **Relative Cliff Check** to ensure the neighborhood isn't poisoned or too sparse.
3. Average and L2-normalize the 1280D embeddings of those neighbors to synthesize a target centroid.

### Genre Penalty (Re-ranking)
After the SQL fetch, tracks are re-ranked based on their distance from the "Anchor Genre":
```typescript
const combinedScore = distance * Math.pow(1 + hopCost, blendWeight * penaltyCurve);
```
- **Hop Cost**: Calculated via the MusicBrainz-based hierarchical genre tree.
- **Veto Logic**: Absolute exclusion of `banned_genres` provided by the LLM.

## 5. Infinity Mode
Infinity Mode leverages a **Weighted Decay Centroid** to keep the music flowing based on your recent listening:

1. **Centroid**: Computes a moving average of the last 10 tracks, weighted toward more recent plays.
2. **Momentum**: Tracks energy/danceability trends to either maintain the "energy" or gradually transition to a new mood.
3. **Relaxation**: If the search pool is too small, the engine automatically broadens its genre-strictness and distance thresholds until suitable matches are found.

## 6. Deduplication & Anti-Repetition
- **Normalized Title Matching**: Prevents the same song from appearing multiple times (e.g., from an album and its "Deluxe" edition).
- **Same-Artist Spacing**: Penalizes tracks from the same artist if they appear too frequently in a sequence.
- **Cross-Playlist Sync**: In the "Hub," tracks are deduplicated across current concepts to ensure variety.
